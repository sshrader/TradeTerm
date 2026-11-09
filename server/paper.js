import { EventEmitter } from 'node:events';
import { clamp, dayKey } from './util.js';

export class PaperError extends Error {}

/** Curve reserves in UI units (SOL / whole tokens). */
export function resOf(t) {
  return {
    vSol: t.vSol / 1e9,
    vTok: t.vTok / 1e6,
    rSol: t.rSol / 1e9,
    rTok: t.rTok >= 0 ? t.rTok / 1e6 : -1,
  };
}

/**
 * Constant-product bonding curve buy: you pay `solIn`; fee is taken on top of what hits the curve.
 * `slipBps` is pessimism for landing latency; it only ever makes fills worse.
 */
export function quoteBuy(res, solIn, feeBps, slipBps) {
  const fee = feeBps / 1e4;
  let net = solIn / (1 + fee);
  let out = (res.vTok * net) / (res.vSol + net);
  let spent = solIn;
  if (res.rTok >= 0 && out > res.rTok) {
    out = res.rTok; // curve nearly full: partial fill
    net = (res.vSol * out) / (res.vTok - out);
    spent = net * (1 + fee);
  }
  const tokens = out * (1 - slipBps / 1e4);
  const spot = res.vSol / res.vTok;
  const avgPrice = tokens > 0 ? spent / tokens : 0;
  return { tokens, spent, feeSol: spent - net, avgPrice, impactPct: tokens > 0 ? (avgPrice / spot - 1) * 100 : 0 };
}

export function quoteSell(res, tokensIn, feeBps, slipBps) {
  let gross = (res.vSol * tokensIn) / (res.vTok + tokensIn);
  if (res.rSol >= 0 && gross > res.rSol) gross = res.rSol;
  const feeSol = (gross * feeBps) / 1e4;
  const net = (gross - feeSol) * (1 - slipBps / 1e4);
  const spot = res.vSol / res.vTok;
  const ideal = spot * tokensIn;
  return { net, gross, feeSol, impactPct: ideal > 0 ? (1 - gross / ideal) * 100 : 0 };
}

const fresh = (cfg) => ({
  enabled: true,
  startSol: cfg.startSol,
  balance: cfg.startSol,
  realized: 0,
  day: dayKey(),
  dayPnl: 0,
  wins: 0,
  losses: 0,
  positions: {},
  history: [],
  nextId: 1,
});

export class PaperEngine extends EventEmitter {
  constructor({ market, cfg }) {
    super();
    this.market = market;
    this.cfg = cfg;
    this.state = fresh(cfg);
    market.on('trade', (t) => this.onTrade(t));
  }

  load(obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.balance !== 'number') return;
    this.state = { ...fresh(this.cfg), ...obj, positions: obj.positions || {}, history: obj.history || [] };
  }

  serialize() {
    return this.state;
  }

  feeBps(t) {
    return t.feeBps ?? this.market.defaultFeeBps;
  }

  _roll() {
    const k = dayKey();
    if (this.state.day !== k) {
      this.state.day = k;
      this.state.dayPnl = 0;
    }
  }

  _live(mint) {
    const t = this.market.tokens.get(mint);
    if (!t || !(t.price > 0)) throw new PaperError('No live price for this token yet.');
    return t;
  }

  quote({ mint, side, sol, pct }) {
    const t = this._live(mint);
    const fee = this.feeBps(t);
    const sup = t.supply / 1e6;
    if (side === 'buy') {
      const q = quoteBuy(resOf(t), Number(sol), fee, this.cfg.slippageBps);
      return { ...q, feeBps: fee, txFeeSol: this.cfg.priorityFeeSol, mcapAfter: null, supply: sup, complete: t.complete };
    }
    const p = this.state.positions[mint];
    if (!p) throw new PaperError('No open position in this token.');
    const tokensIn = (p.tokens * clamp(Number(pct), 0.1, 100)) / 100;
    const q = quoteSell(resOf(t), tokensIn, fee, this.cfg.slippageBps);
    const proceeds = Math.max(0, q.net - this.cfg.priorityFeeSol);
    const costPortion = (p.costSol * clamp(Number(pct), 0.1, 100)) / 100;
    return { tokensIn, proceeds, pnl: proceeds - costPortion, impactPct: q.impactPct, feeSol: q.feeSol, feeBps: fee, txFeeSol: this.cfg.priorityFeeSol };
  }

  buy(mint, sol, { tp = null, sl = null } = {}) {
    this._roll();
    const s = this.state;
    const c = this.cfg;
    sol = Number(sol);
    if (!s.enabled) throw new PaperError('Kill switch is on: new buys are blocked.');
    if (!(sol >= 0.001)) throw new PaperError('Amount too small.');
    const t = this._live(mint);
    if (t.complete) throw new PaperError('Token graduated: bonding-curve buys are closed.');
    if (s.dayPnl <= -c.dailyLossCapSol) throw new PaperError(`Daily loss cap reached (${c.dailyLossCapSol} SOL).`);
    const pos = s.positions[mint];
    if (!pos && Object.keys(s.positions).length >= c.maxOpen) throw new PaperError(`Max ${c.maxOpen} open positions.`);
    if (sol + c.priorityFeeSol > s.balance + 1e-12) throw new PaperError('Insufficient paper balance.');
    if ((pos?.costSol || 0) + sol + c.priorityFeeSol > c.maxPositionSol + 1e-9) {
      throw new PaperError(`Position limit: max ${c.maxPositionSol} SOL per token.`);
    }
    const q = quoteBuy(resOf(t), sol, this.feeBps(t), c.slippageBps);
    if (!(q.tokens > 0)) throw new PaperError('Nothing left to buy on the curve.');

    s.balance -= q.spent + c.priorityFeeSol;
    const p =
      pos ||
      (s.positions[mint] = { mint, symbol: t.symbol, name: t.name, tokens: 0, costSol: 0, realizedSol: 0, openedAt: Date.now(), tp: null, sl: null });
    p.tokens += q.tokens;
    p.costSol += q.spent + c.priorityFeeSol;
    if (tp != null && Number(tp) > 0) p.tp = Number(tp);
    if (sl != null && Number(sl) > 0) p.sl = clamp(Number(sl), 1, 99);
    this._log({ mint, symbol: t.symbol, side: 'buy', sol: q.spent, tokens: q.tokens, mc: t.price * (t.supply / 1e6), reason: 'manual' });
    this._changed();
    return q;
  }

  sell(mint, pct, reason = 'manual') {
    this._roll();
    const s = this.state;
    const c = this.cfg;
    const p = s.positions[mint];
    if (!p) throw new PaperError('No open position in this token.');
    const t = this._live(mint);
    pct = clamp(Number(pct), 0.1, 100);
    const tokensIn = (p.tokens * pct) / 100;
    const q = quoteSell(resOf(t), tokensIn, this.feeBps(t), c.slippageBps);
    const proceeds = Math.max(0, q.net - c.priorityFeeSol);
    const costPortion = (p.costSol * pct) / 100;
    const pnl = proceeds - costPortion;
    s.balance += proceeds;
    s.realized += pnl;
    s.dayPnl += pnl;
    p.realizedSol += pnl;
    p.tokens -= tokensIn;
    p.costSol -= costPortion;
    if (pct >= 99.99 || p.tokens < 1e-9) {
      delete s.positions[mint];
      if (p.realizedSol > 0) s.wins++;
      else s.losses++;
    }
    this._log({ mint, symbol: t.symbol ?? p.symbol, side: 'sell', sol: proceeds, tokens: tokensIn, mc: t.price * (t.supply / 1e6), pnl, reason });
    this._changed();
    return { proceeds, pnl };
  }

  setExits(mint, tp, sl) {
    const p = this.state.positions[mint];
    if (!p) throw new PaperError('No open position in this token.');
    p.tp = tp != null && Number(tp) > 0 ? Number(tp) : null;
    p.sl = sl != null && Number(sl) > 0 ? clamp(Number(sl), 1, 99) : null;
    this._changed();
  }

  setEnabled(on) {
    this.state.enabled = Boolean(on);
    this._changed();
  }

  reset() {
    this.state = fresh(this.cfg);
    this._changed();
  }

  onTrade(t) {
    const p = this.state.positions[t.mint];
    if (!p || (p.tp == null && p.sl == null) || !(t.price > 0)) return;
    const q = quoteSell(resOf(t), p.tokens, this.feeBps(t), this.cfg.slippageBps);
    const value = Math.max(0, q.net - this.cfg.priorityFeeSol);
    const pct = (value / p.costSol - 1) * 100;
    let reason = null;
    if (p.tp != null && pct >= p.tp) reason = 'tp';
    else if (p.sl != null && pct <= -p.sl) reason = 'sl';
    if (!reason) return;
    try {
      const sym = t.symbol ?? p.symbol;
      const r = this.sell(t.mint, 100, reason);
      this.emit('auto', { mint: t.mint, symbol: sym, reason, pnl: r.pnl });
    } catch {
      /* position vanished or price missing: ignore */
    }
  }

  _log(entry) {
    const s = this.state;
    s.history.unshift({ id: s.nextId++, t: Date.now(), ...entry });
    if (s.history.length > 200) s.history.length = 200;
  }

  _changed() {
    this.emit('change');
  }

  view() {
    this._roll();
    const s = this.state;
    const c = this.cfg;
    const positions = Object.values(s.positions).map((p) => {
      const t = this.market.tokens.get(p.mint);
      let value = null;
      let mcap = null;
      let entryMcap = null;
      if (t && t.price > 0) {
        const q = quoteSell(resOf(t), p.tokens, this.feeBps(t), c.slippageBps);
        value = Math.max(0, q.net - c.priorityFeeSol);
        mcap = t.price * (t.supply / 1e6);
        entryMcap = (p.costSol / p.tokens) * (t.supply / 1e6);
      }
      return {
        mint: p.mint,
        symbol: t?.symbol ?? p.symbol,
        name: t?.name ?? p.name,
        tokens: p.tokens,
        costSol: p.costSol,
        value,
        pnlSol: value == null ? null : value - p.costSol,
        pnlPct: value == null ? null : (value / p.costSol - 1) * 100,
        tp: p.tp,
        sl: p.sl,
        openedAt: p.openedAt,
        mcap,
        entryMcap,
        live: Boolean(t),
        complete: Boolean(t?.complete),
      };
    });
    const openValue = positions.reduce((a, p) => a + (p.value ?? p.costSol), 0);
    return {
      enabled: s.enabled,
      startSol: s.startSol,
      balance: s.balance,
      equity: s.balance + openValue,
      realized: s.realized,
      dayPnl: s.dayPnl,
      wins: s.wins,
      losses: s.losses,
      positions,
      history: s.history.slice(0, 60),
      limits: { ...c },
    };
  }
}
