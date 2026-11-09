import crypto from 'node:crypto';
import { b58encode } from './util.js';

// Simulated pump.fun market using the same bonding-curve math and the same event shapes as the
// live decoder, so every part of the terminal (feed, chart, risk, wallets, paper trading) can be
// explored without an API key. Nothing here is real market data.

const A = ['Giga', 'Based', 'Turbo', 'Neon', 'Quantum', 'Cyber', 'Lunar', 'Sigma', 'Pixel', 'Void', 'Mango', 'Zen', 'Ghost', 'Laser', 'Atomic', 'Cosmic', 'Banana', 'Pizza', 'Hyper', 'Ultra', 'Mega', 'Tiny', 'Rapid', 'Silent'];
const B = ['Frog', 'Cat', 'Dog', 'Ape', 'Otter', 'Yeti', 'Chad', 'Wojak', 'Rocket', 'Lambo', 'Gem', 'Wizard', 'Goblin', 'Shark', 'Panda', 'Moon', 'Pepe', 'Bonk', 'Duck', 'Fox', 'Whale', 'Llama', 'Raccoon', 'Hamster'];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const key = () => b58encode(crypto.randomBytes(32));
const INIT_RTOK = 793_100_000;

function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

export class Demo {
  constructor(market) {
    this.market = market;
    this.slot = 300_000_000;
    this.fee = 125;
    this.tokens = [];
    this.wallets = Array.from({ length: 460 }, key);
    this.smart = this.wallets.slice(0, 8);
    this.bots = this.wallets.slice(8, 40);
    this.retail = this.wallets.slice(40);
  }

  start() {
    setInterval(() => this.slot++, 400).unref();
    const now = Date.now();
    for (let i = 0; i < 16; i++) this._spawn(rnd(20_000, 420_000), now);
    setInterval(() => this._tick(), 100).unref();
    const loop = () => {
      this._spawn(0, Date.now());
      setTimeout(loop, rnd(1500, 4200)).unref();
    };
    setTimeout(loop, 1500).unref();
  }

  _slotAt(now) {
    return this.slot - Math.round((Date.now() - now) / 400);
  }

  _spawn(back, realNow) {
    const roll = Math.random();
    const persona = roll < 0.12 ? 'moon' : roll < 0.55 ? 'normal' : roll < 0.73 ? 'rug' : 'dead';
    const a = pick(A);
    const b = pick(B);
    const solo = Math.random() < 0.35;
    const c = {
      mint: key(),
      name: solo ? b : `${a} ${b}`,
      symbol: (solo ? b : a[0] + b).toUpperCase().slice(0, 6),
      persona,
      creator: key(),
      born: realNow - back,
      vSol: 30,
      vTok: 1_073_000_000,
      rSol: 0,
      rTok: INIT_RTOK,
      holders: new Map(),
      done: false,
      dumpAt: rnd(25, 110),
      dumped: false,
      smartPlan: [],
    };
    const now = c.born;
    const slot = this._slotAt(now);
    this.market.handleCreate(
      {
        type: 'create',
        name: c.name,
        symbol: c.symbol,
        uri: 'demo://' + c.mint,
        mint: c.mint,
        bondingCurve: key(),
        user: c.creator,
        creator: c.creator,
        vTok: 1_073_000_000_000_000,
        vSol: 30_000_000_000,
        rTok: 793_100_000_000_000,
        supply: 1e15,
        quoteMint: null,
      },
      { slot, now, warm: back > 0 },
    );
    this._buy(c, c.creator, persona === 'rug' ? rnd(1, 4.5) : rnd(0.1, 1.8), slot, now);
    if (Math.random() < (persona === 'rug' ? 0.55 : 0.2)) {
      const n = 4 + Math.floor(Math.random() * 6);
      for (let i = 0; i < n; i++) this._buy(c, pick(this.bots), rnd(0.1, 1.2), slot, now);
    } else if (Math.random() < 0.5) {
      for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i++) this._buy(c, pick(this.bots), rnd(0.1, 0.8), slot + 1, now);
    }
    if (persona === 'moon') {
      const k = 1 + Math.floor(Math.random() * 3);
      for (const w of [...this.smart].sort(() => Math.random() - 0.5).slice(0, k)) {
        c.smartPlan.push({ w, buyAt: rnd(2, 25), sol: rnd(0.4, 1.6), sellProg: rnd(0.55, 0.9), bought: false, sold: false });
      }
    } else if (persona === 'rug' && Math.random() < 0.12) {
      c.smartPlan.push({ w: pick(this.smart), buyAt: rnd(2, 8), sol: rnd(0.3, 0.8), sellAge: rnd(20, 40), bought: false, sold: false });
    } else if (persona === 'normal' && Math.random() < 0.35) {
      c.smartPlan.push({ w: pick(this.smart), buyAt: rnd(5, 30), sol: rnd(0.3, 1), sellAge: rnd(40, 100), bought: false, sold: false });
    }
    this.tokens.push(c);
    if (back > 0) {
      for (let t = now + 250; t < realNow; t += 250) this._step(c, t, 0.25);
    }
  }

  _buy(c, w, sol, slot, now) {
    if (c.done) return;
    const fee = 1 + this.fee / 1e4;
    let net = sol / fee;
    let out = (c.vTok * net) / (c.vSol + net);
    if (out >= c.rTok) {
      out = c.rTok;
      net = (c.vSol * out) / (c.vTok - out);
    }
    if (!(out > 0)) return;
    c.vSol += net;
    c.vTok -= out;
    c.rSol += net;
    c.rTok -= out;
    c.holders.set(w, (c.holders.get(w) || 0) + out);
    this._emit(c, w, true, net, out, slot, now);
    if (c.rTok <= 1e-6) {
      c.rTok = 0;
      c.done = true;
    }
  }

  _sell(c, w, frac, slot, now) {
    const have = c.holders.get(w) || 0;
    if (have <= 0.01 || c.done) return;
    const tIn = have * frac;
    const gross = Math.min((c.vSol * tIn) / (c.vTok + tIn), c.rSol);
    c.vSol -= gross;
    c.vTok += tIn;
    c.rSol -= gross;
    c.rTok += tIn;
    if (have - tIn <= 0.01) c.holders.delete(w);
    else c.holders.set(w, have - tIn);
    this._emit(c, w, false, gross, tIn, slot, now);
  }

  _emit(c, w, isBuy, sol, tok, slot, now) {
    this.market.handleTrade(
      {
        type: 'trade',
        mint: c.mint,
        solAmount: Math.round(sol * 1e9),
        tokenAmount: Math.round(tok * 1e6),
        isBuy,
        user: w,
        ts: Math.floor(now / 1000),
        vSol: Math.round(c.vSol * 1e9),
        vTok: Math.round(c.vTok * 1e6),
        rSol: Math.round(c.rSol * 1e9),
        rTok: Math.max(0, Math.round(c.rTok * 1e6)),
        feeBps: this.fee,
        creator: c.creator,
        quoteMint: null,
      },
      { slot, now, warm: Date.now() - now > 2000 },
    );
  }

  _step(c, now, dt) {
    if (c.done) return;
    const age = (now - c.born) / 1000;
    const slot = this._slotAt(now);
    const prog = 1 - c.rTok / INIT_RTOK;

    // smart wallets with a plan
    for (const p of c.smartPlan) {
      if (!p.bought && age >= p.buyAt) {
        p.bought = true;
        this._buy(c, p.w, p.sol, slot, now);
      } else if (p.bought && !p.sold && ((p.sellProg && prog >= p.sellProg) || (p.sellAge && age >= p.sellAge) || age > 240)) {
        p.sold = true;
        this._sell(c, p.w, 1, slot, now);
      }
    }
    if (c.persona === 'rug' && !c.dumped && age >= c.dumpAt) {
      c.dumped = true;
      this._sell(c, c.creator, 1, slot, now);
      for (const b of this.bots) this._sell(c, b, rnd(0.6, 1), slot, now);
    }
    if (c.done) return;

    let rate;
    switch (c.persona) {
      case 'moon':
        rate = 7 * Math.exp(-age / 240) + 0.6;
        break;
      case 'normal':
        rate = 3 * Math.exp(-age / 90) + 0.15;
        break;
      case 'rug':
        rate = 4 * Math.exp(-age / 60) + 0.1;
        break;
      default:
        rate = 0.25 * Math.exp(-age / 40) + 0.02;
    }
    const n = poisson(rate * dt);
    for (let i = 0; i < n && !c.done; i++) {
      let pBuy;
      if (c.persona === 'moon') pBuy = 0.7 - Math.min(0.15, age / 1500);
      else if (c.persona === 'rug') pBuy = c.dumped ? 0.2 : 0.65;
      else if (c.persona === 'normal') pBuy = Math.max(0.42, 0.55 - age / 900);
      else pBuy = 0.45;
      if (Math.random() < pBuy || c.holders.size < 2) {
        const w = Math.random() < 0.08 ? pick(this.bots) : pick(this.retail);
        const sol = Math.random() < 0.015 ? rnd(3, 9) : Math.min(6, Math.exp(rnd(-3.2, 0.6)));
        this._buy(c, w, sol, slot, now);
      } else {
        const keys = [...c.holders.keys()].filter((w) => w !== c.creator && !c.smartPlan.some((p) => p.w === w && !p.sold));
        if (keys.length) this._sell(c, pick(keys), rnd(0.3, 1), slot, now);
      }
    }
  }

  _tick() {
    const now = Date.now();
    for (const c of this.tokens) this._step(c, now, 0.1);
    if (this.tokens.length > 60) this.tokens = this.tokens.filter((c) => !c.done && now - c.born < 15 * 60_000).slice(-50);
  }
}
