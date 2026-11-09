import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, ROOT } from './config.js';
import { redact, isPubkey } from './util.js';
import { Market, INTERVALS } from './store.js';
import { WalletBook } from './wallets.js';
import { PaperEngine, PaperError } from './paper.js';
import { CreditMeter, Rpc, LogStream } from './rpc.js';
import { decoderStats } from './decoder.js';
import { verifyMint } from './chain.js';
import { getMeta, getImage } from './meta.js';
import { fetchSolUsd } from './price.js';
import { Demo } from './demo.js';

const WEB = path.join(ROOT, 'web');
const mode = config.demo ? 'demo' : 'live';
fs.mkdirSync(config.dataDir, { recursive: true });
const stateFile = path.join(config.dataDir, `state.${mode}.json`);

// ---------------------------------------------------------------- core objects
const wallets = new WalletBook();
const market = new Market({ maxTokens: config.maxTokens, partialMinSol: config.partialMinSol, defaultFeeBps: config.defaultFeeBps, wallets });
const paper = new PaperEngine({ market, cfg: config.paper });
const meter = new CreditMeter(config.dataDir, config.creditBudget);
const rpc = config.hasKey ? new Rpc({ url: config.rpcUrl, rps: config.rpcMaxRps, meter }) : null;
let stream = null;
let demo = null;

// ---------------------------------------------------------------- persistence
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    paper.load(j.paper);
    for (const [w, l] of Object.entries(j.watch || {})) if (isPubkey(w)) market.watch.set(w, String(l).slice(0, 40));
  } catch {
    /* first run */
  }
}
function saveNow() {
  try {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ paper: paper.serialize(), watch: Object.fromEntries(market.watch) }));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error('state save failed:', e.message);
  }
}
let saveTimer = null;
const scheduleSave = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 2000);
  saveTimer.unref();
};

// ---------------------------------------------------------------- SSE clients
const clients = new Map();
let alertsBuf = [];
let autoBuf = [];
let paperDirty = true;

function updatePins() {
  const s = new Set(Object.keys(paper.state.positions));
  for (const c of clients.values()) if (c.sel) s.add(c.sel);
  market.pinned = s;
}
market.on('wallet', (a) => alertsBuf.push(a));
paper.on('auto', (a) => autoBuf.push(a));
paper.on('change', () => {
  paperDirty = true;
  scheduleSave();
  updatePins();
});

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function watchList() {
  return [...market.watch].map(([wallet, label]) => ({ wallet, label, stats: wallets.profile(wallet) }));
}

function statusObj() {
  const now = Date.now();
  return {
    mode,
    demoReason: config.demoReason,
    version: config.version,
    uptime: now - market.stats.startedAt,
    stream: demo || !stream
      ? { state: 'demo', evPerSec: market.evPerSec }
      : { state: stream.state, evPerSec: market.evPerSec, ageMs: now - stream.lastMsgAt, reconnects: stream.reconnects, error: stream.lastError },
    rpc: rpc ? { ...meter.snapshot(), calls: rpc.stats.calls, ok: rpc.stats.ok, error: rpc.stats.lastError } : null,
    solUsd: market.solUsd,
    tokens: market.tokens.size,
    wallets: wallets.w.size,
    decoder: { ...decoderStats, droppedNonSol: market.stats.droppedNonSol },
  };
}

function publicConfig() {
  return { paper: config.paper, intervals: Object.keys(INTERVALS) };
}

function flush() {
  const dirty = market.takeDirty();
  const evicted = market.evicted.splice(0);
  const alerts = alertsBuf.splice(0).slice(-20);
  const autos = autoBuf.splice(0);
  if (!clients.size) return;
  const now = Date.now();
  const summaries = dirty.map((t) => market.summary(t, now));
  const dirtySet = new Set(dirty.map((t) => t.mint));
  const posDirty = paperDirty || dirty.some((t) => paper.state.positions[t.mint]);
  paperDirty = false;
  const base = { tokens: summaries, evicted, alerts, autos, paper: posDirty ? paper.view() : null, solUsd: market.solUsd };
  const baseStr = JSON.stringify(base);
  const idle = !summaries.length && !evicted.length && !alerts.length && !autos.length && !base.paper;
  for (const [id, c] of clients) {
    let sel = null;
    if (c.sel && dirtySet.has(c.sel)) {
      const t = market.tokens.get(c.sel);
      if (t) {
        const candles = {};
        for (const k of Object.keys(INTERVALS)) candles[k] = t.candles[k].slice(-2);
        sel = { mint: t.mint, trades: t.recent.filter((x) => x.seq > c.seq), candles };
        c.seq = t.seq;
        if (now - c.extraAt > 2000) {
          sel.holders = market.holdersOf(t);
          sel.risk = market.riskOf(t);
          c.extraAt = now;
        }
      }
    }
    if (idle && !sel) continue;
    try {
      c.res.write(`event: upd\ndata: ${sel ? baseStr.slice(0, -1) + ',"sel":' + JSON.stringify(sel) + '}' : baseStr}\n\n`);
    } catch {
      clients.delete(id);
    }
  }
}
setInterval(flush, 250).unref();
setInterval(() => {
  const st = statusObj();
  for (const [id, c] of clients) {
    try {
      send(c.res, 'status', st);
    } catch {
      clients.delete(id);
    }
  }
}, 2000).unref();
setInterval(() => {
  for (const c of clients.values()) c.res.write(': ping\n\n');
}, 15000).unref();

// ---------------------------------------------------------------- http helpers
const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC });
  res.end(body);
}
const fail = (res, code, error) => json(res, code, { ok: false, error });

// Blocks DNS-rebinding (Host check) and cross-site POSTs (Origin + JSON content type).
function guard(req, res) {
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
    fail(res, 403, 'Forbidden host');
    return false;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const o = req.headers.origin;
    if (o && !(o.startsWith('http://') && allowedHosts.has(o.slice(7).toLowerCase()))) {
      fail(res, 403, 'Forbidden origin');
      return false;
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      fail(res, 415, 'JSON required');
      return false;
    }
  }
  return true;
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return fail(res, 400, 'Bad path');
  }
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...SEC });
    res.end(buf);
  });
}

function handleEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SEC });
  const id = crypto.randomBytes(8).toString('hex');
  clients.set(id, { res, sel: null, seq: 0, extraAt: 0 });
  res.write('retry: 2000\n\n');
  const now = Date.now();
  send(res, 'init', {
    cid: id,
    status: statusObj(),
    tokens: [...market.tokens.values()].map((t) => market.summary(t, now)),
    paper: paper.view(),
    watch: watchList(),
    solUsd: market.solUsd,
    config: publicConfig(),
  });
  req.on('close', () => {
    clients.delete(id);
    updatePins();
  });
}

// Deterministic fake verification for demo tokens.
function demoVerify(t) {
  const h = parseInt(crypto.createHash('sha1').update(t.mint).digest('hex').slice(0, 8), 16);
  const top = market.holdersOf(t);
  return {
    mintAuthority: null,
    freezeAuthority: h % 9 === 0 ? 'DemoFreezeAuthority1111111111111111111111' : null,
    supply: t.supply,
    decimals: 6,
    holders: top.slice(0, 10).map((x) => ({ owner: x.wallet, pct: x.pct, kind: 'wallet' })),
    top1Pct: top[0]?.pct ?? 0,
    top10Pct: top.slice(0, 10).reduce((a, x) => a + x.pct, 0),
    checkedAt: Date.now(),
    simulated: true,
  };
}
let verifying = false;

// ---------------------------------------------------------------- routes
async function route(req, res) {
  if (!guard(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const get = req.method === 'GET' || req.method === 'HEAD';

  if (get && p === '/events') return handleEvents(req, res);
  if (get && p === '/api/status') return json(res, 200, statusObj());

  let m;
  if (get && (m = p.match(/^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
    const t = market.tokens.get(m[1]);
    if (!t) return fail(res, 404, 'Token not tracked (it may have been evicted).');
    const c = clients.get(url.searchParams.get('cid'));
    if (c) {
      c.sel = t.mint;
      c.seq = t.seq;
      c.extraAt = Date.now();
      updatePins();
    }
    return json(res, 200, { ok: true, ...market.detail(t), onchain: market.onchain.get(t.mint) || null });
  }
  if (get && (m = p.match(/^\/api\/meta\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
    const t = market.tokens.get(m[1]);
    if (!t) return fail(res, 404, 'Token not tracked.');
    return json(res, 200, { ok: true, meta: await getMeta(t, { demo: config.demo }) });
  }
  if (get && (m = p.match(/^\/api\/img\/([a-zA-Z0-9]{46,100})$/))) {
    try {
      const img = await getImage(m[1]);
      res.writeHead(200, { 'content-type': img.type, 'cache-control': 'max-age=86400', 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' });
      return res.end(img.buf);
    } catch {
      return fail(res, 404, 'Image unavailable');
    }
  }
  if (get && p === '/api/quote') {
    try {
      const q = paper.quote({ mint: url.searchParams.get('mint'), side: url.searchParams.get('side'), sol: url.searchParams.get('sol'), pct: url.searchParams.get('pct') });
      return json(res, 200, { ok: true, quote: q });
    } catch (e) {
      return fail(res, 200, e instanceof PaperError ? e.message : 'Quote failed');
    }
  }
  if (get && p === '/api/paper') return json(res, 200, { ok: true, paper: paper.view() });
  if (get && p === '/api/wallets/top') return json(res, 200, { ok: true, rows: wallets.top(Number(url.searchParams.get('min')) || 2, 30), tracked: wallets.w.size });
  if (get && p === '/api/watch') return json(res, 200, { ok: true, watch: watchList() });

  if (req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return fail(res, 400, e.message);
    }
    const act = (fn) => {
      try {
        const out = fn();
        return json(res, 200, { ok: true, paper: paper.view(), ...(out || {}) });
      } catch (e) {
        if (e instanceof PaperError) return fail(res, 200, e.message);
        throw e;
      }
    };
    if (p === '/api/paper/buy') {
      if (!isPubkey(body.mint)) return fail(res, 400, 'Bad mint');
      return act(() => ({ fill: paper.buy(body.mint, body.sol, { tp: body.tp, sl: body.sl }) }));
    }
    if (p === '/api/paper/sell') {
      if (!isPubkey(body.mint)) return fail(res, 400, 'Bad mint');
      return act(() => ({ fill: paper.sell(body.mint, body.pct) }));
    }
    if (p === '/api/paper/exits') {
      if (!isPubkey(body.mint)) return fail(res, 400, 'Bad mint');
      return act(() => paper.setExits(body.mint, body.tp, body.sl));
    }
    if (p === '/api/paper/toggle') return act(() => paper.setEnabled(body.enabled));
    if (p === '/api/paper/reset') return act(() => paper.reset());

    if (p === '/api/watch') {
      if (!isPubkey(body.wallet)) return fail(res, 400, 'That does not look like a Solana wallet address.');
      if (market.watch.size >= 100 && !market.watch.has(body.wallet)) return fail(res, 400, 'Watchlist is full (100).');
      const label = String(body.label || '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 32);
      market.watch.set(body.wallet, label || 'Wallet');
      scheduleSave();
      return json(res, 200, { ok: true, watch: watchList() });
    }
    if (p === '/api/unwatch') {
      market.watch.delete(body.wallet);
      scheduleSave();
      return json(res, 200, { ok: true, watch: watchList() });
    }
    if (p === '/api/verify') {
      if (!isPubkey(body.mint)) return fail(res, 400, 'Bad mint');
      const t = market.tokens.get(body.mint);
      if (!t) return fail(res, 404, 'Token not tracked.');
      const prev = market.onchain.get(t.mint);
      if (prev && !prev.error && Date.now() - prev.checkedAt < 120_000) return json(res, 200, { ok: true, onchain: prev, risk: market.riskOf(t), cached: true });
      if (config.demo) {
        const r = demoVerify(t);
        market.onchain.set(t.mint, r);
        market.refreshRisk(t.mint);
        return json(res, 200, { ok: true, onchain: r, risk: market.riskOf(t) });
      }
      if (verifying) return fail(res, 429, 'Another verification is running. Try again in a moment.');
      verifying = true;
      try {
        const r = await verifyMint(rpc, t.mint);
        market.onchain.set(t.mint, r);
        market.refreshRisk(t.mint);
        return json(res, 200, { ok: true, onchain: r, risk: market.riskOf(t) });
      } catch (e) {
        const msg = redact(e.message);
        market.onchain.set(t.mint, { error: msg, checkedAt: Date.now() });
        market.refreshRisk(t.mint);
        return fail(res, 502, msg);
      } finally {
        verifying = false;
      }
    }
    return fail(res, 404, 'Unknown endpoint');
  }

  if (get) return serveStatic(res, p);
  return fail(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('request error:', redact(e.stack || e.message));
    if (!res.headersSent) fail(res, 500, 'Internal error');
    else res.end();
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use. Set PORT=<other> in .env or close the other process.\n`);
  else console.error('server error:', e.message);
  process.exit(1);
});

// ---------------------------------------------------------------- data sources
function onNotification(n) {
  for (const e of n.events) {
    if (e.type === 'create') market.handleCreate(e, { slot: n.slot, sig: n.signature });
    else market.handleTrade(e, { slot: n.slot, sig: n.signature });
  }
}

async function refreshSol() {
  const v = await fetchSolUsd();
  if (v) market.solUsd = v;
  else if (config.demo && !market.solUsd) market.solUsd = 150; // demo fallback so USD views work offline
}

loadState();
updatePins();

server.listen(config.port, config.host, async () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n  PULSE terminal v${config.version}`);
  if (config.demo) {
    console.log(`  mode  : DEMO (simulated market)${config.demoReason === 'no-key' ? ' - add HELIUS_API_KEY to .env for live data' : ''}`);
    demo = new Demo(market);
    demo.start();
    if (!market.watch.size) demo.smart.slice(0, 3).forEach((w, i) => market.watch.set(w, `Demo smart #${i + 1}`));
  } else {
    console.log('  mode  : LIVE (Helius logsSubscribe on pump.fun)');
    stream = new LogStream({ url: config.wsUrl });
    stream.on('notification', onNotification);
    stream.start();
    rpc
      .call('getSlot', [], { retries: 0 })
      .then((s) => console.log(`  rpc   : ok (slot ${s})`))
      .catch((e) => console.log(`  rpc   : FAILED - ${redact(e.message)}`));
  }
  console.log(`  open  : ${url}\n`);
  refreshSol();
  setInterval(refreshSol, 60_000).unref();
  if (config.openBrowser) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* ignore */
    }
  }
});

function shutdown() {
  saveNow();
  meter.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
