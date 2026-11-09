import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { quoteBuy, quoteSell, PaperEngine } from '../server/paper.js';
import { Market } from '../server/store.js';
import { b58encode } from '../server/util.js';

const res = () => ({ vSol: 30, vTok: 1_073_000_000, rSol: 0, rTok: 793_100_000 });
const cfg = { startSol: 10, maxPositionSol: 1, maxOpen: 2, dailyLossCapSol: 2, slippageBps: 0, priorityFeeSol: 0 };
const key = () => b58encode(crypto.randomBytes(32));

test('curve is path independent with no fees: buy then sell returns the same SOL', () => {
  const r = res();
  const b = quoteBuy(r, 1, 0, 0);
  const after = { vSol: r.vSol + 1, vTok: r.vTok - b.tokens, rSol: r.rSol + 1, rTok: r.rTok - b.tokens };
  const s = quoteSell(after, b.tokens, 0, 0);
  assert.ok(Math.abs(s.net - 1) < 1e-9);
});

test('fees and slippage always make the round trip lose money', () => {
  const r = res();
  const b = quoteBuy(r, 1, 125, 50);
  const after = { vSol: r.vSol + 1, vTok: r.vTok - b.tokens, rSol: r.rSol + 1, rTok: r.rTok - b.tokens };
  assert.ok(quoteSell(after, b.tokens, 125, 50).net < 0.97);
});

test('buys are capped at the tokens left on the curve', () => {
  const r = { ...res(), rTok: 1000 };
  const b = quoteBuy(r, 50, 100, 0);
  assert.ok(b.tokens <= 1000 + 1e-9);
  assert.ok(b.spent < 50);
});

function setup(c = cfg) {
  const market = new Market({});
  const paper = new PaperEngine({ market, cfg: c });
  const mint = key();
  const dev = key();
  market.handleCreate(
    { type: 'create', name: 'Test', symbol: 'TST', uri: 'demo://t', mint, bondingCurve: key(), user: dev, creator: dev, vTok: 1_073_000_000_000_000, vSol: 30_000_000_000, rTok: 793_100_000_000_000, supply: 1e15 },
    { slot: 1, now: Date.now() },
  );
  return { market, paper, mint };
}

test('engine enforces risk limits and the kill switch', () => {
  const { paper, mint } = setup();
  assert.throws(() => paper.buy(mint, 1.5), /Position limit/);
  paper.buy(mint, 0.5);
  assert.equal(Object.keys(paper.state.positions).length, 1);
  paper.setEnabled(false);
  assert.throws(() => paper.buy(mint, 0.1), /Kill switch/);
  assert.doesNotThrow(() => paper.sell(mint, 100)); // exits stay available
  assert.equal(Object.keys(paper.state.positions).length, 0);
});

test('take-profit fires automatically when the price moves', () => {
  const { market, paper, mint } = setup();
  paper.buy(mint, 0.5, { tp: 100 });
  const dev = key();
  // a large buy pushes virtual SOL from 30 to 60 (price x4)
  market.handleTrade(
    { type: 'trade', mint, solAmount: 30e9, tokenAmount: 5e14, isBuy: true, user: dev, ts: 1, vSol: 60e9, vTok: 5.365e14, rSol: 30e9, rTok: 3.0e14, feeBps: 125, creator: null, quoteMint: null },
    { slot: 2, now: Date.now() },
  );
  assert.equal(Object.keys(paper.state.positions).length, 0);
  assert.equal(paper.state.history[0].reason, 'tp');
  assert.ok(paper.state.realized > 0);
});

test('stop-loss fires on a dump', () => {
  const { market, paper, mint } = setup();
  paper.buy(mint, 0.5, { sl: 30 });
  market.handleTrade(
    { type: 'trade', mint, solAmount: 5e9, tokenAmount: 5e14, isBuy: false, user: key(), ts: 1, vSol: 20e9, vTok: 1.6e15, rSol: 1e9, rTok: 8.0e14, feeBps: 125, creator: null, quoteMint: null },
    { slot: 2, now: Date.now() },
  );
  assert.equal(paper.state.history[0].reason, 'sl');
  assert.ok(paper.state.realized < 0);
});

test('max open positions is enforced', () => {
  const a = setup();
  const m2 = key();
  const m3 = key();
  for (const m of [m2, m3]) {
    a.market.handleCreate(
      { type: 'create', name: 'X', symbol: 'X', uri: 'demo://x', mint: m, bondingCurve: key(), user: key(), creator: key(), vTok: 1_073_000_000_000_000, vSol: 30_000_000_000, rTok: 793_100_000_000_000, supply: 1e15 },
      { slot: 1, now: Date.now() },
    );
  }
  a.paper.buy(a.mint, 0.1);
  a.paper.buy(m2, 0.1);
  assert.throws(() => a.paper.buy(m3, 0.1), /open positions/);
});
