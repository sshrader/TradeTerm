import { Buffer } from 'node:buffer';
import { b58encode } from './util.js';

// Layouts verified against the pump.fun IDL / community parsers (Nov 2026).
// Events are read straight from transaction logs ("Program data: <base64>"),
// so no getTransaction call (and no RPC credit) is needed per trade.

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL = 'So11111111111111111111111111111111111111112';
const ZERO_KEY = '11111111111111111111111111111111';

const TRADE_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const CREATE_DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const PREFIX = 'Program data: ';
// First 4 base64 chars of each discriminator (3 bytes -> 4 chars): cheap pre-filter.
const TRADE_B64 = 'vdt/';
const CREATE_B64 = 'G3Kp';

export const decoderStats = { trades: 0, creates: 0, nonSol: 0, tailMismatch: 0, bad: 0 };

const pkCache = new Map();
function pk(buf, off) {
  const raw = buf.toString('latin1', off, off + 32);
  let s = pkCache.get(raw);
  if (s === undefined) {
    s = b58encode(buf.subarray(off, off + 32));
    if (pkCache.size > 30000) pkCache.clear();
    pkCache.set(raw, s);
  }
  return s;
}

// u64/i64 as a JS number (exact below 2^53, which covers lamports and raw token amounts here).
const u64 = (buf, o) => buf.readUInt32LE(o) + buf.readUInt32LE(o + 4) * 4294967296;

// Strip control and bidi-override characters: token names are attacker-controlled.
const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();

function readStr(buf, o, max) {
  if (o + 4 > buf.length) return null;
  const len = buf.readUInt32LE(o);
  if (len > 2000 || o + 4 + len > buf.length) return null;
  return [clean(buf.toString('utf8', o + 4, o + 4 + len)).slice(0, max), o + 4 + len];
}

const isSolQuote = (k) => k === ZERO_KEY || k === WSOL;

// Newer pump.fun versions can quote against non-SOL assets. All our math is in SOL, so those are skipped.
// The tail is variable-length, so the quote mint is only trusted if the walk lands exactly on the buffer end.
function tradeQuoteMint(buf, o) {
  if (o + 33 > buf.length) return null;
  o += 33; // track_volume + 4 x u64
  const s = readStr(buf, o, 64);
  if (!s) return null;
  o = s[1];
  o += 1 + 8 + 8; // mayhem_mode, cashback_fee_basis_points, cashback
  o += 16; // buyback_fee_basis_points, buyback_fee
  if (o + 4 > buf.length) return null;
  const n = buf.readUInt32LE(o);
  if (n > 64) return null;
  o += 4 + n * 34;
  if (o + 32 + 24 !== buf.length) return null;
  return pk(buf, o);
}

function decodeTrade(buf) {
  const B = 8;
  if (buf.length < B + 121) return null;
  const ev = {
    type: 'trade',
    mint: pk(buf, B),
    solAmount: u64(buf, B + 32),
    tokenAmount: u64(buf, B + 40),
    isBuy: buf[B + 48] === 1,
    user: pk(buf, B + 49),
    ts: u64(buf, B + 81),
    vSol: u64(buf, B + 89),
    vTok: u64(buf, B + 97),
    rSol: u64(buf, B + 105),
    rTok: u64(buf, B + 113),
    feeBps: null,
    creator: null,
    quoteMint: null,
  };
  if (buf.length >= B + 217) {
    const fee = u64(buf, B + 153);
    const cfee = u64(buf, B + 201);
    if (fee + cfee <= 500) ev.feeBps = fee + cfee;
    ev.creator = pk(buf, B + 169);
    const q = tradeQuoteMint(buf, B + 217);
    if (q && !isSolQuote(q)) ev.quoteMint = q;
    else if (q === null && buf.length > B + 217 + 120) decoderStats.tailMismatch++;
  }
  return ev;
}

function decodeCreate(buf) {
  let o = 8;
  let r = readStr(buf, o, 64);
  if (!r) return null;
  const name = r[0];
  o = r[1];
  r = readStr(buf, o, 24);
  if (!r) return null;
  const symbol = r[0];
  o = r[1];
  r = readStr(buf, o, 300);
  if (!r) return null;
  const uri = r[0];
  o = r[1];
  if (o + 96 > buf.length) return null;
  const ev = {
    type: 'create',
    name,
    symbol,
    uri,
    mint: pk(buf, o),
    bondingCurve: pk(buf, o + 32),
    user: pk(buf, o + 64),
    creator: null,
    quoteMint: null,
  };
  o += 96;
  ev.creator = ev.user;
  if (o + 72 <= buf.length) {
    ev.creator = pk(buf, o);
    ev.vTok = u64(buf, o + 40);
    ev.vSol = u64(buf, o + 48);
    ev.rTok = u64(buf, o + 56);
    ev.supply = u64(buf, o + 64);
    o += 72;
    // token_program(32) is_mayhem(1) is_cashback(1) quote_mint(32) virtual_quote_reserves(8)
    if (o + 32 + 1 + 1 + 32 + 8 === buf.length) {
      const q = pk(buf, o + 34);
      if (!isSolQuote(q)) ev.quoteMint = q;
    }
  }
  return ev;
}

/** Decode pump.fun events from one transaction's log lines. */
export function extractEvents(logs) {
  const out = [];
  const stack = [];
  for (const line of logs) {
    if (line.startsWith(PREFIX)) {
      if (stack[stack.length - 1] !== PUMP_PROGRAM) continue;
      if (line.length > 5000) continue;
      const head = line.substr(PREFIX.length, 4);
      if (head !== TRADE_B64 && head !== CREATE_B64) continue;
      try {
        const buf = Buffer.from(line.slice(PREFIX.length), 'base64');
        let ev = null;
        if (head === TRADE_B64 && buf.subarray(0, 8).equals(TRADE_DISC)) {
          ev = decodeTrade(buf);
          if (ev) decoderStats.trades++;
        } else if (head === CREATE_B64 && buf.subarray(0, 8).equals(CREATE_DISC)) {
          ev = decodeCreate(buf);
          if (ev) decoderStats.creates++;
        }
        if (ev) {
          if (ev.quoteMint) decoderStats.nonSol++;
          out.push(ev);
        } else decoderStats.bad++;
      } catch {
        decoderStats.bad++;
      }
    } else if (line.startsWith('Program ')) {
      if (line.includes(' invoke [')) stack.push(line.slice(8, line.indexOf(' ', 8)));
      else if (line.endsWith(' success') || line.includes(' failed')) stack.pop();
    }
  }
  return out;
}

/** logsNotification message -> { slot, signature, events } (null for failed txs / other messages). */
export function parseLogsNotification(msg) {
  const r = msg?.params?.result;
  const v = r?.value;
  if (!v || v.err || !Array.isArray(v.logs)) return null;
  const events = extractEvents(v.logs);
  if (!events.length) return null;
  return { slot: r.context?.slot ?? 0, signature: v.signature, events };
}
