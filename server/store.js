import { EventEmitter } from 'node:events';
import { assess } from './risk.js';
import { clamp } from './util.js';

export const INTERVALS = { '1s': 1000, '5s': 5000, '15s': 15000, '1m': 60000 };
const CAPS = { '1s': 1200, '5s': 900, '15s': 600, '1m': 720 };
const DEFAULT_SUPPLY = 1e15; // raw units: 1B tokens, 6 decimals
const DEFAULT_INIT_RTOK = 793_100_000_000_000;
const LEDGER_CAP = 4000;

function pushCandle(arr, step, cap, now, price, vol, isBuy) {
  const bucket = Math.floor(now / step) * step;
  let c = arr[arr.length - 1];
  if (!c || c.t < bucket) {
    const o = c ? c.c : price;
    c = { t: bucket, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: 0, n: 0, bv: 0 };
    arr.push(c);
    if (arr.length > cap) arr.shift();
  } else {
    if (price > c.h) c.h = price;
    if (price < c.l) c.l = price;
    c.c = price;
  }
  c.v += vol;
  c.n++;
  if (isBuy) c.bv += vol;
}

export class Market extends EventEmitter {
  constructor({ maxTokens = 800, partialMinSol = 0.5, defaultFeeBps = 125, wallets = null } = {}) {
    super();
    this.maxTokens = maxTokens;
    this.partialMinSol = partialMinSol;
    this.defaultFeeBps = defaultFeeBps;
    this.wallets = wallets;
    this.tokens = new Map();
    this.pinned = new Set();
    this.watch = new Map(); // wallet -> label
    this.onchain = new Map(); // mint -> verification result
    this.dirty = new Set();
    this.evicted = [];
    this.solUsd = null;
    this.stats = { events: 0, trades: 0, creates: 0, droppedNonSol: 0, startedAt: Date.now() };
    this._sec = 0;
    this._cnt = 0;
    this._ring = [];
    setInterval(() => this.prune(), 20_000).unref();
  }

  get evPerSec() {
    const r = this._ring.slice(-5);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0;
  }

  _tick(now) {
    this.stats.events++;
    const s = Math.floor(now / 1000);
    if (s !== this._sec) {
      if (this._sec) {
        this._ring.push(this._cnt);
        if (this._ring.length > 10) this._ring.shift();
      }
      this._cnt = 0;
      this._sec = s;
    }
    this._cnt++;
  }

  newToken(mint, now, partial) {
    return {
      mint,
      name: null,
      symbol: null,
      uri: null,
      creator: null,
      bondingCurve: null,
      createdAt: now,
      createSlot: null,
      firstSeen: now,
      partial,
      supply: DEFAULT_SUPPLY,
      initRTok: DEFAULT_INIT_RTOK,
      price: 0,
      vSol: 0,
      vTok: 0,
      rSol: 0,
      rTok: -1,
      complete: false,
      feeBps: null,
      athPrice: 0,
      lastTradeAt: 0,
      seq: 0,
      buys: 0,
      sells: 0,
      buyVol: 0,
      sellVol: 0,
      traders: new Set(),
      balances: new Map(),
      ledgerFull: false,
      devBought: 0,
      devSold: 0,
      snipers: new Map(),
      earlySlots: new Map(),
      bundled: false,
      candles: { '1s': [], '5s': [], '15s': [], '1m': [] },
      recent: [],
      cache: { top: null, top10Pct: 0, topAt: 0, risk: null, riskAt: 0 },
      holdersDirty: true,
    };
  }

  handleCreate(e, ctx = {}) {
    const now = ctx.now ?? Date.now();
    if (!ctx.warm) this._tick(now);
    if (e.quoteMint) {
      this.stats.droppedNonSol++;
      return;
    }
    this.stats.creates++;
    let t = this.tokens.get(e.mint);
    if (!t) {
      t = this.newToken(e.mint, now, false);
      this.tokens.set(e.mint, t);
    }
    t.name = e.name || null;
    t.symbol = e.symbol || null;
    t.uri = e.uri || null;
    t.creator = e.creator || e.user;
    t.bondingCurve = e.bondingCurve;
    t.createdAt = now;
    t.createSlot = ctx.slot ?? null;
    t.partial = false;
    if (e.supply) t.supply = e.supply;
    if (e.rTok) {
      t.initRTok = e.rTok;
      t.rTok = e.rTok;
    }
    if (e.vSol > 0 && e.vTok > 0) {
      t.vSol = e.vSol;
      t.vTok = e.vTok;
      t.price = e.vSol / 1e9 / (e.vTok / 1e6);
      t.athPrice = t.price;
    }
    this.dirty.add(t.mint);
    if (this.tokens.size > this.maxTokens * 1.1) this.prune();
  }

  handleTrade(e, ctx = {}) {
    const now = ctx.now ?? Date.now();
    if (!ctx.warm) this._tick(now);
    if (e.quoteMint) {
      this.stats.droppedNonSol++;
      return;
    }
    if (!(e.vSol > 0 && e.vTok > 0)) return;
    this.stats.trades++;
    const sol = e.solAmount / 1e9;
    const tok = e.tokenAmount / 1e6;
    this.wallets?.record(e.user, e.mint, e.isBuy, sol, tok, now);

    const watched = this.watch.has(e.user);
    let t = this.tokens.get(e.mint);
    if (!t) {
      // Tokens first seen mid-life are only tracked when something makes them interesting.
      if (!watched && !this.pinned.has(e.mint) && sol < this.partialMinSol) return;
      t = this.newToken(e.mint, now, true);
      this.tokens.set(e.mint, t);
      if (this.tokens.size > this.maxTokens * 1.1) this.prune();
    }

    const price = e.vSol / 1e9 / (e.vTok / 1e6);
    t.price = price;
    t.vSol = e.vSol;
    t.vTok = e.vTok;
    t.rSol = e.rSol;
    t.rTok = e.rTok;
    if (e.feeBps != null) t.feeBps = e.feeBps;
    if (e.creator && !t.creator) t.creator = e.creator;
    if (e.rTok === 0) t.complete = true;
    if (price > t.athPrice) t.athPrice = price;
    t.lastTradeAt = now;
    t.seq++;
    if (e.isBuy) {
      t.buys++;
      t.buyVol += sol;
    } else {
      t.sells++;
      t.sellVol += sol;
    }
    if (t.traders.size < 6000) t.traders.add(e.user);
    for (const k of Object.keys(INTERVALS)) pushCandle(t.candles[k], INTERVALS[k], CAPS[k], now, price, sol, e.isBuy);

    this._ledger(t, e.user, e.isBuy ? tok : -tok);

    const isDev = t.creator && e.user === t.creator;
    if (isDev) {
      if (e.isBuy) t.devBought += tok;
      else t.devSold += tok;
    }

    if (!t.partial && t.createSlot != null && ctx.slot != null && e.isBuy && !isDev) {
      const ds = ctx.slot - t.createSlot;
      if (ds >= 0 && ds <= 3) {
        let set = t.earlySlots.get(ctx.slot);
        if (!set) t.earlySlots.set(ctx.slot, (set = new Set()));
        set.add(e.user);
        if (set.size >= 4) t.bundled = true;
        if (ds <= 1) t.snipers.set(e.user, ds);
      }
    }

    const mc = price * (t.supply / 1e6);
    t.recent.push({ seq: t.seq, t: now, s: e.isBuy ? 1 : 0, sol, tok, mc, w: e.user, sig: ctx.sig || null });
    if (t.recent.length > 150) t.recent.shift();
    t.holdersDirty = true;
    this.dirty.add(t.mint);

    if (watched) {
      this.emit('wallet', {
        t: now,
        wallet: e.user,
        label: this.watch.get(e.user),
        mint: t.mint,
        symbol: t.symbol,
        side: e.isBuy ? 'buy' : 'sell',
        sol,
        mc,
      });
    }
    this.emit('trade', t);
  }

  _ledger(t, user, delta) {
    const b = t.balances.get(user);
    if (b === undefined) {
      if (delta <= 0) return;
      if (t.balances.size >= LEDGER_CAP) {
        t.ledgerFull = true;
        return;
      }
      t.balances.set(user, delta);
      return;
    }
    const nb = b + delta;
    if (nb <= 0.01) t.balances.delete(user);
    else t.balances.set(user, nb);
  }

  _win(t, now, ms) {
    const c = t.candles['1m'];
    const start = now - ms;
    let v = 0;
    let n = 0;
    let bv = 0;
    for (let i = c.length - 1; i >= 0 && c[i].t + 60000 > start; i--) {
      v += c[i].v;
      n += c[i].n;
      bv += c[i].bv;
    }
    return { v, n, bv };
  }

  _open(t, now, ms) {
    const c = t.candles['1m'];
    for (let i = 0; i < c.length; i++) if (c[i].t >= now - ms) return c[i].o;
    return null;
  }

  _dev(t) {
    const sup = t.supply / 1e6;
    const bal = t.creator ? t.balances.get(t.creator) || 0 : 0;
    let status = 'unknown';
    if (!t.creator) status = 'unknown';
    else if (t.devSold > 0 && bal < 0.01) status = 'sold_all';
    else if (t.devBought > 0 && t.devSold / t.devBought > 0.2) status = 'sold_some';
    else if (bal >= 0.01) status = 'holding';
    else status = t.partial ? 'unknown' : 'none';
    return { status, pct: bal / sup, bought: t.devBought, sold: t.devSold };
  }

  _top(t, now) {
    const c = t.cache;
    if (c.top && (!t.holdersDirty || now - c.topAt < 2000)) return c;
    const arr = [...t.balances];
    arr.sort((a, b) => b[1] - a[1]);
    const sup = t.supply / 1e6;
    c.top = arr.slice(0, 20).map(([wallet, bal]) => ({
      wallet,
      bal,
      pct: bal / sup,
      dev: wallet === t.creator,
      sniper: t.snipers.has(wallet),
    }));
    c.top10Pct = c.top.slice(0, 10).reduce((a, h) => a + h.pct, 0);
    c.topAt = now;
    t.holdersDirty = false;
    return c;
  }

  _risk(t, now) {
    const c = t.cache;
    if (c.risk && now - c.riskAt < 3000) return c.risk;
    const sup = t.supply / 1e6;
    let snipeBal = 0;
    for (const w of t.snipers.keys()) snipeBal += t.balances.get(w) || 0;
    c.risk = assess({
      t,
      top: this._top(t, now),
      dev: this._dev(t),
      snipePct: snipeBal / sup,
      snipeCount: t.snipers.size,
      w5: this._win(t, now, 300000),
      now,
      onchain: this.onchain.get(t.mint),
    });
    c.riskAt = now;
    return c.risk;
  }

  holdersOf(t) {
    return this._top(t, Date.now()).top;
  }

  riskOf(t) {
    return this._risk(t, Date.now());
  }

  /** Invalidate cached risk (after on-chain verification). */
  refreshRisk(mint) {
    const t = this.tokens.get(mint);
    if (t) {
      t.cache.riskAt = 0;
      this.dirty.add(mint);
    }
  }

  summary(t, now = Date.now()) {
    const sup = t.supply / 1e6;
    const w5 = this._win(t, now, 300000);
    const o5 = this._open(t, now, 300000);
    const risk = this._risk(t, now);
    const dev = this._dev(t);
    return {
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      createdAt: t.createdAt,
      partial: t.partial,
      price: t.price,
      mcap: t.price * sup,
      ath: t.athPrice * sup,
      prog: t.rTok >= 0 ? clamp(1 - t.rTok / t.initRTok, 0, 1) : 0,
      complete: t.complete,
      v5: w5.v,
      n5: w5.n,
      buyPct5: w5.v > 0 ? w5.bv / w5.v : null,
      chg5: o5 && o5 > 0 ? (t.price / o5 - 1) * 100 : null,
      holders: t.balances.size,
      top10: this._top(t, now).top10Pct,
      dev: dev.status,
      devPct: dev.pct,
      snipers: t.snipers.size,
      bundled: t.bundled,
      risk: { score: risk.score, level: risk.level, verified: risk.verified },
      lastTradeAt: t.lastTradeAt,
      buys: t.buys,
      sells: t.sells,
    };
  }

  detail(t) {
    const now = Date.now();
    const out = { candles: {} };
    for (const k of Object.keys(INTERVALS)) out.candles[k] = t.candles[k].slice(-400);
    return {
      ...out,
      summary: this.summary(t, now),
      seq: t.seq,
      trades: t.recent.slice(-80),
      holders: this._top(t, now).top,
      risk: this._risk(t, now),
      supply: t.supply / 1e6,
      creator: t.creator,
      bondingCurve: t.bondingCurve,
      feeBps: t.feeBps ?? this.defaultFeeBps,
    };
  }

  takeDirty() {
    const out = [];
    for (const m of this.dirty) {
      const t = this.tokens.get(m);
      if (t) out.push(t);
    }
    this.dirty.clear();
    return out;
  }

  prune() {
    if (this.tokens.size <= this.maxTokens) return;
    const cands = [...this.tokens.values()].filter((t) => !this.pinned.has(t.mint));
    cands.sort((a, b) => (a.lastTradeAt || a.firstSeen) - (b.lastTradeAt || b.firstSeen));
    let drop = this.tokens.size - Math.floor(this.maxTokens * 0.85);
    for (const t of cands) {
      if (drop-- <= 0) break;
      this.tokens.delete(t.mint);
      this.onchain.delete(t.mint);
      this.evicted.push(t.mint);
    }
  }
}
