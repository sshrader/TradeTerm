// Owner-only coin launch on pump.fun. Off unless LAUNCH_ENABLED=1.
//
// The coin is built and signed in YOUR browser wallet (web/launch/), so this server never holds a private key.
// The server only: hosts the coin's info file and picture (pump.fun reads them from a public https link, and the file is
// fixed once the coin exists), forwards a short list of RPC calls (so a private RPC key stays off the page), and remembers
// what was launched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();

export const launchEnabled = () => env('LAUNCH_ENABLED') === '1';
const defaultNetwork = () => (env('LAUNCH_NETWORK', 'devnet') === 'mainnet' ? 'mainnet' : 'devnet');
const maxDevBuy = () => {
  const v = Number(env('LAUNCH_MAX_DEV_BUY_SOL', '5'));
  return Number.isFinite(v) && v > 0 ? v : 5;
};
const oneOnly = () => env('LAUNCH_ONE_ONLY') === '1';
const owner = () => env('LAUNCH_OWNER'); // optional: only this wallet may record a launch
const dir = () => path.resolve(config.dataDir, 'launch');
const historyFile = () => path.join(dir(), 'history.json');
const publicBase = () => (env('LAUNCH_PUBLIC_URL') || config.publicUrl || '').replace(/\/+$/, '');

const UPSTREAM = {
  devnet: () => env('LAUNCH_DEVNET_RPC_URL') || 'https://api.devnet.solana.com',
  mainnet: () => env('LAUNCH_RPC_URL') || 'https://api.mainnet-beta.solana.com',
};

export class LaunchError extends Error {}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;
const ID = /^[a-f0-9]{24}$/;

// ---------------------------------------------------------------- validation
const HOSTS = { website: null, twitter: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], telegram: ['t.me', 'telegram.me'] };
const LABEL = { website: 'Website', twitter: 'X / Twitter', telegram: 'Telegram' };

// eslint-disable-next-line no-control-regex
const BAD_TEXT = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;

export function cleanUrl(kind, v) {
  const t = String(v ?? '').trim();
  if (!t) return '';
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new LaunchError(`${LABEL[kind]} must be a full link starting with https://`);
  }
  if (u.protocol !== 'https:' || t.length > 200 || /[\s<>"']/.test(t)) throw new LaunchError(`${LABEL[kind]} must be a plain https:// link.`);
  if (HOSTS[kind] && !HOSTS[kind].includes(u.hostname.toLowerCase())) throw new LaunchError(`${LABEL[kind]} must be a link on ${HOSTS[kind][0]}.`);
  return u.toString().replace(/\/$/, '');
}

/** Checks the form fields. Returns the cleaned values or throws a LaunchError that says what to fix. */
export function cleanFields(b) {
  const name = String(b?.name ?? '').trim();
  const symbol = String(b?.symbol ?? '').trim().replace(/^\$/, '').toUpperCase();
  const description = String(b?.description ?? '').trim();
  if (!name) throw new LaunchError('Enter a coin name.');
  if (name.length > 32) throw new LaunchError('The name can be at most 32 characters.');
  if (!symbol) throw new LaunchError('Enter a ticker.');
  if (symbol.length > 10) throw new LaunchError('The ticker can be at most 10 characters.');
  if (!/^[A-Z0-9_]+$/.test(symbol)) throw new LaunchError('The ticker can only use letters, numbers and underscores.');
  if (description.length > 600) throw new LaunchError('The description can be at most 600 characters.');
  if (BAD_TEXT.test(name) || BAD_TEXT.test(symbol) || BAD_TEXT.test(description.replace(/[\r\n\t]/g, ' '))) throw new LaunchError('Remove hidden or control characters from the text.');
  return { name, symbol, description, website: cleanUrl('website', b?.website), twitter: cleanUrl('twitter', b?.twitter), telegram: cleanUrl('telegram', b?.telegram) };
}

export function cleanNetwork(n) {
  if (n === 'mainnet' || n === 'devnet') return n;
  throw new LaunchError('Network must be devnet or mainnet.');
}

/** Reads the real picture type from the first bytes (the browser's claim is not trusted). */
export function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

export const MAX_IMAGE = 1_500_000;

export function decodeImage(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new LaunchError('Add a coin picture (PNG, JPG, GIF or WebP).');
  const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
  if (buf.length > MAX_IMAGE) throw new LaunchError('The picture is over 1.5 MB. Use a smaller one.');
  const kind = sniffImage(buf);
  if (!kind) throw new LaunchError('That file is not a PNG, JPG, GIF or WebP picture.');
  return { buf, ...kind };
}

export function devBuyOk(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new LaunchError('Enter a dev buy above 0 SOL.');
  if (n > maxDevBuy()) throw new LaunchError(`The dev buy is capped at ${maxDevBuy()} SOL (LAUNCH_MAX_DEV_BUY_SOL).`);
  return n;
}

// ---------------------------------------------------------------- history
function readHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

export function record({ network, mint, signature, user, name, symbol, devBuySol, id }) {
  cleanNetwork(network);
  if (!B58.test(String(mint)) || !SIG.test(String(signature)) || !B58.test(String(user))) throw new LaunchError('Bad launch result.');
  if (owner() && user !== owner()) throw new LaunchError('This wallet is not the launch owner.');
  const hist = readHistory();
  if (oneOnly() && hist.some((h) => h.network === network)) throw new LaunchError('A launch is already saved for this network (LAUNCH_ONE_ONLY).');
  if (hist.some((h) => h.signature === signature)) return hist[hist.length - 1];
  const rec = {
    network,
    mint,
    signature,
    user,
    name: String(name ?? '').slice(0, 32),
    symbol: String(symbol ?? '').slice(0, 10),
    devBuySol: Number(devBuySol) || 0,
    id: ID.test(String(id)) ? id : '',
    at: new Date().toISOString(),
  };
  hist.push(rec);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify(hist.slice(-200), null, 1));
  return rec;
}

// ---------------------------------------------------------------- RPC proxy
// Only what a launch needs. Everything else is refused, so this cannot be used as a general-purpose RPC.
export const RPC_METHODS = new Set([
  'getGenesisHash', 'getBalance', 'getLatestBlockhash', 'getBlockHeight', 'getSlot', 'getAccountInfo', 'getMultipleAccounts',
  'getSignatureStatuses', 'simulateTransaction', 'sendTransaction', 'getMinimumBalanceForRentExemption', 'getFeeForMessage',
  'getRecentPrioritizationFees', 'isBlockhashValid', 'getEpochInfo', 'getVersion', 'requestAirdrop',
]);

export function checkRpcBody(body, network) {
  const one = (b) => {
    if (!b || typeof b !== 'object' || !RPC_METHODS.has(b.method)) throw new LaunchError(`RPC method not allowed: ${String(b?.method).slice(0, 40)}`);
    if (b.method === 'requestAirdrop' && network !== 'devnet') throw new LaunchError('Airdrops exist only on devnet.');
  };
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) throw new LaunchError('Too many calls at once.');
    body.forEach(one);
  } else one(body);
}

async function rpc(network, body) {
  checkRpcBody(body, network);
  const r = await fetch(UPSTREAM[network](), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LaunchError('The RPC node sent an unreadable answer.');
  }
}

// ---------------------------------------------------------------- public files (no password: pump.fun and wallets fetch them)
const CORS = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

/** Serves /launch-meta/<id>.json and /launch-img/<id>. Returns true if the request was one of these. */
export function handlePublic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let m = p.match(/^\/launch-meta\/([a-f0-9]{24})\.json$/);
  if (m) {
    try {
      const buf = fs.readFileSync(path.join(dir(), `${m[1]}.json`));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'content-security-policy': "default-src 'none'; sandbox", ...CORS });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', ...CORS });
      res.end('Not found');
    }
    return true;
  }
  m = p.match(/^\/launch-img\/([a-f0-9]{24})$/);
  if (m) {
    try {
      const f = fs.readdirSync(dir()).find((x) => x.startsWith(`${m[1]}.`) && !x.endsWith('.json'));
      if (!f) throw new Error('none');
      const buf = fs.readFileSync(path.join(dir(), f));
      const kind = sniffImage(buf);
      if (!kind) throw new Error('bad');
      res.writeHead(200, { 'content-type': kind.type, 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'; sandbox", ...CORS });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', ...CORS });
      res.end('Not found');
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- owner API
function configView() {
  const base = publicBase();
  return {
    enabled: true,
    defaultNetwork: defaultNetwork(),
    maxDevBuySol: maxDevBuy(),
    oneOnly: oneOnly(),
    owner: owner(),
    publicBase: base,
    publicHttps: base.startsWith('https://'),
    history: readHistory().slice(-20).reverse(),
  };
}

let prepared = [];

/**
 * Handles /api/launch/*. `h` carries the server's helpers: json, fail, readJson, base (the request's own origin).
 * Returns true if the request was handled.
 */
export async function handleApi(req, res, p, h) {
  if (!p.startsWith('/api/launch')) return false;
  if (!launchEnabled()) {
    h.fail(res, 404, 'Not found');
    return true;
  }
  if (req.method === 'GET' && p === '/api/launch/config') {
    h.json(res, 200, { ok: true, ...configView() });
    return true;
  }
  if (req.method !== 'POST') {
    h.fail(res, 405, 'Method not allowed');
    return true;
  }
  try {
    let m;
    if ((m = p.match(/^\/api\/launch\/rpc\/(devnet|mainnet)$/))) {
      const body = await h.readJson(req, 256 * 1024);
      h.json(res, 200, await rpc(m[1], body));
      return true;
    }
    if (p === '/api/launch/prepare') {
      const body = await h.readJson(req, 2.4 * 1024 * 1024);
      const network = cleanNetwork(body.network);
      const f = cleanFields(body);
      const dev = devBuyOk(body.devBuySol);
      const img = decodeImage(body.image);
      const base = publicBase() || h.base;
      if (network === 'mainnet' && !base.startsWith('https://')) throw new LaunchError('A mainnet launch needs a public https address for the coin info. Deploy on Railway or set LAUNCH_PUBLIC_URL.');
      const now = Date.now();
      prepared = prepared.filter((t) => now - t < 3600_000);
      if (prepared.length >= 30) throw new LaunchError('Too many pictures prepared in the last hour. Wait a bit.');
      prepared.push(now);
      const id = crypto.randomBytes(12).toString('hex');
      const image = `${base}/launch-img/${id}`;
      const uri = `${base}/launch-meta/${id}.json`;
      if (uri.length > 200) throw new LaunchError('The public address is too long for pump.fun (200 characters).');
      const meta = { name: f.name, symbol: f.symbol, description: f.description, image, showName: true, createdOn: 'https://pump.fun' };
      for (const k of ['website', 'twitter', 'telegram']) if (f[k]) meta[k] = f[k];
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(path.join(dir(), `${id}.${img.ext}`), img.buf);
      fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify(meta, null, 2));
      h.json(res, 200, { ok: true, id, uri, image, meta, devBuySol: dev, network });
      return true;
    }
    if (p === '/api/launch/record') {
      const body = await h.readJson(req);
      h.json(res, 200, { ok: true, record: record(body), history: configView().history });
      return true;
    }
    h.fail(res, 404, 'Unknown endpoint');
  } catch (e) {
    if (e instanceof LaunchError) h.fail(res, 200, e.message);
    else if (/Body too large|Invalid JSON/.test(String(e?.message))) h.fail(res, 400, e.message);
    else h.fail(res, 502, 'Launch request failed.');
  }
  return true;
}
