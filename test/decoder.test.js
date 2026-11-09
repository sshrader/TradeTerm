import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { extractEvents, parseLogsNotification, PUMP_PROGRAM, WSOL } from '../server/decoder.js';
import { b58encode } from '../server/util.js';

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHA.indexOf(c));
  const hex = n.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s) => Buffer.concat([Buffer.from(new Uint32Array([Buffer.byteLength(s)]).buffer), Buffer.from(s)]);
const TRADE_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const CREATE_DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

function tradeBuf(o) {
  return Buffer.concat([
    TRADE_DISC,
    o.mint,
    u64(o.sol),
    u64(o.tok),
    Buffer.from([o.isBuy ? 1 : 0]),
    o.user,
    u64(1_700_000_000),
    u64(o.vSol),
    u64(o.vTok),
    u64(o.rSol),
    u64(o.rTok),
    crypto.randomBytes(32), // fee_recipient
    u64(100),
    u64(1),
    o.creator,
    u64(30),
    u64(1),
    ...(o.tail ? [o.tail] : []),
  ]);
}

// track_volume, 4x u64, ix_name, mayhem, cashback bps, cashback, buyback bps+fee, shareholders=0, quote mint + 3 u64
function tail(quoteMint) {
  return Buffer.concat([Buffer.alloc(1 + 32), str('buy'), Buffer.alloc(1 + 16), Buffer.alloc(16), Buffer.alloc(4), quoteMint, Buffer.alloc(24)]);
}

const wrap = (buf, id = PUMP_PROGRAM) => [`Program ${id} invoke [1]`, 'Program log: Instruction: Buy', `Program data: ${buf.toString('base64')}`, `Program ${id} success`];

const base = () => ({
  mint: crypto.randomBytes(32),
  user: crypto.randomBytes(32),
  creator: crypto.randomBytes(32),
  sol: 1_500_000_000,
  tok: 25_000_000_000,
  isBuy: true,
  vSol: 31_500_000_000,
  vTok: 1_020_000_000_000_000,
  rSol: 1_500_000_000,
  rTok: 740_000_000_000_000,
});

test('base58 matches a roundtrip and the all-zero key', () => {
  assert.equal(b58encode(Buffer.alloc(32)), '11111111111111111111111111111111');
  const k = crypto.randomBytes(32);
  assert.deepEqual(b58decode(b58encode(k)), k);
});

test('decodes a trade event with fee fields', () => {
  const o = base();
  const [ev, ...rest] = extractEvents(wrap(tradeBuf(o)));
  assert.equal(rest.length, 0);
  assert.equal(ev.type, 'trade');
  assert.equal(ev.mint, b58encode(o.mint));
  assert.equal(ev.user, b58encode(o.user));
  assert.equal(ev.creator, b58encode(o.creator));
  assert.equal(ev.solAmount, 1_500_000_000);
  assert.equal(ev.tokenAmount, 25_000_000_000);
  assert.equal(ev.isBuy, true);
  assert.equal(ev.vSol, 31_500_000_000);
  assert.equal(ev.rTok, 740_000_000_000_000);
  assert.equal(ev.feeBps, 130);
  assert.equal(ev.quoteMint, null);
});

test('ignores program data emitted by other programs', () => {
  const other = b58encode(crypto.randomBytes(32));
  assert.equal(extractEvents(wrap(tradeBuf(base()), other)).length, 0);
});

test('non-SOL quote mints are flagged, SOL and WSOL are not', () => {
  const usdcLike = crypto.randomBytes(32);
  const [a] = extractEvents(wrap(tradeBuf({ ...base(), tail: tail(usdcLike) })));
  assert.equal(a.quoteMint, b58encode(usdcLike));
  const wsol = b58decode(WSOL);
  const [b] = extractEvents(wrap(tradeBuf({ ...base(), tail: tail(wsol) })));
  assert.equal(b.quoteMint, null);
  const [c] = extractEvents(wrap(tradeBuf({ ...base(), tail: tail(Buffer.alloc(32)) })));
  assert.equal(c.quoteMint, null);
});

test('a tail that does not line up is never trusted as a quote mint', () => {
  const junk = Buffer.concat([tail(crypto.randomBytes(32)), Buffer.from([1, 2, 3])]);
  const [ev] = extractEvents(wrap(tradeBuf({ ...base(), tail: junk })));
  assert.equal(ev.quoteMint, null);
});

test('decodes a create event and strips control characters', () => {
  const mint = crypto.randomBytes(32);
  const curve = crypto.randomBytes(32);
  const user = crypto.randomBytes(32);
  const creator = crypto.randomBytes(32);
  const buf = Buffer.concat([
    CREATE_DISC,
    str('Evil‮Tok\u0007en'),
    str('EVL'),
    str('https://ipfs.io/ipfs/QmTest'),
    mint,
    curve,
    user,
    creator,
    u64(1_700_000_000),
    u64(1_073_000_000_000_000),
    u64(30_000_000_000),
    u64(793_100_000_000_000),
    u64(1_000_000_000_000_000),
  ]);
  const [ev] = extractEvents(wrap(buf));
  assert.equal(ev.type, 'create');
  assert.equal(ev.name, 'EvilToken');
  assert.equal(ev.symbol, 'EVL');
  assert.equal(ev.mint, b58encode(mint));
  assert.equal(ev.bondingCurve, b58encode(curve));
  assert.equal(ev.creator, b58encode(creator));
  assert.equal(ev.supply, 1_000_000_000_000_000);
  assert.equal(ev.rTok, 793_100_000_000_000);
});

test('failed transactions and truncated payloads are skipped', () => {
  const logs = wrap(tradeBuf(base()));
  const ok = { params: { result: { context: { slot: 5 }, value: { signature: 'sig', err: null, logs } } } };
  assert.equal(parseLogsNotification(ok).events.length, 1);
  assert.equal(parseLogsNotification({ params: { result: { context: { slot: 5 }, value: { signature: 'sig', err: { InstructionError: [0, 'x'] }, logs } } } }), null);
  assert.equal(extractEvents(wrap(tradeBuf(base()).subarray(0, 60))).length, 0);
});
