import { Buffer } from 'node:buffer';

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = BigInt('0x0' + buf.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHA[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export const isPubkey = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// Secrets (API keys) must never reach logs or the browser.
const secrets = [];
export function addSecret(s) {
  if (s && s.length > 6) secrets.push(s);
}
export function redact(input) {
  let s = String(input ?? '');
  for (const k of secrets) s = s.split(k).join('***');
  return s.replace(/(api[-_]?key=)[^&\s"']+/gi, '$1***');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
