import { Chart } from './chart.js';
import { LWChart, lwAvailable } from './lwchart.js';

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('pulse.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pulse.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const getJson = (u) => fetch(u).then((r) => r.json());
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(3);
}
// Tiny prices use the subscript-zero convention: 0.0₄5400 means 0.00005400
function fmtPrice(n) {
  if (!(n > 0)) return '0';
  if (n >= 1) return n.toFixed(2);
  const zeros = Math.floor(-Math.log10(n));
  if (zeros < 3) return n.toFixed(zeros + 4);
  const sig = String(Math.round(n * Math.pow(10, zeros + 4))).padStart(4, '0').slice(0, 4);
  return '0.0' + [...String(zeros)].map((d) => '₀₁₂₃₄₅₆₇₈₉'[d]).join('') + sig;
}
const short = (m) => (m ? m.slice(0, 4) + '…' + m.slice(-4) : '');
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const sgn = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d);
function age(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function avatar(mint, symbol, imgCid) {
  const h = hash(mint);
  const a = h % 360;
  const b = (a + 50 + ((h >> 8) % 110)) % 360;
  const d = el('div', { class: 'av' }, (symbol || '?').slice(0, 1).toUpperCase());
  d.style.background = `linear-gradient(135deg, hsl(${a} 85% 52%), hsl(${b} 85% 40%))`;
  if (imgCid) {
    const img = el('img', { alt: '', src: '/api/img/' + imgCid, loading: 'lazy' });
    img.addEventListener('error', () => img.remove());
    d.append(img);
  }
  return d;
}

/* ------------------------------------------------------------------ state */
const STEP = { '1s': 1000, '5s': 5000, '15s': 15000, '1m': 60000 };
const S = {
  cid: null, status: null, solUsd: null, tokens: new Map(), rows: new Map(),
  tab: store.get('tab', 'new'), view: 'dash', search: '', hideHigh: store.get('hideHigh', false),
  interval: store.get('interval', '5s'), unit: store.get('unit', 'usd'),
  sel: null, detail: null, meta: null, lastSeq: 0, trades: [],
  dock: store.get('dock', 'trades'), side: 'buy', buyAmt: store.get('buyAmt', 0.25), sellPct: 100,
  tp: store.get('tp', 100), sl: store.get('sl', 30), posTab: 'open',
  paper: null, watch: [], alerts: [], unread: 0, top: [], limits: null,
};
const BOARD_TABS = [['new', 'New'], ['hot', 'Hot'], ['final', 'Final stretch'], ['grad', 'Graduated']];
const DOCK_TABS = [['trades', 'Trades'], ['holders', 'Holders'], ['wallets', 'Wallets'], ['alerts', 'Alerts']];

const useUsd = () => S.unit === 'usd' && S.solUsd > 0;
const mcVal = (sol) => (useUsd() ? sol * S.solUsd : sol);
const fmtMc = (sol) => (useUsd() ? '$' + compact(sol * S.solUsd) : compact(sol) + ' SOL');
const fmtAxis = (v) => (useUsd() ? '$' + compact(v) : v.toFixed(v < 10 ? 2 : 1));
const fmtSol = (n, d = 3) => n.toFixed(d);

/* ------------------------------------------------------------------ toasts */
function toast(title, body, kind = '', onclick) {
  const t = el('div', { class: 'toast ' + kind, role: 'status' }, el('b', {}, title), body ? el('span', {}, body) : null);
  t.addEventListener('click', () => { t.remove(); onclick?.(); });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 5000);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

/* ------------------------------------------------------------------ heartbeat (driven by live events/sec) */
const hb = $('#hb');
const hbx = hb.getContext('2d');
const hbData = new Array(84).fill(0);
let evRate = 0;
setInterval(() => {
  const spike = Math.random() < Math.min(0.7, 0.08 + evRate / 45);
  const amp = Math.min(1, 0.25 + evRate / 40);
  hbData.push(spike ? (Math.random() < 0.5 ? 1 : -0.65) * amp * (0.6 + Math.random() * 0.4) : (Math.random() - 0.5) * 0.06);
  hbData.shift();
}, 70);
function drawHb() {
  const d = window.devicePixelRatio || 1;
  if (hb.width !== 168 * d) { hb.width = 168 * d; hb.height = 36 * d; hbx.setTransform(d, 0, 0, d, 0, 0); }
  hbx.clearRect(0, 0, 168, 36);
  const g = hbx.createLinearGradient(0, 0, 168, 0);
  g.addColorStop(0, 'rgba(124,92,255,0)');
  g.addColorStop(0.45, '#7c5cff');
  g.addColorStop(1, '#29d3ff');
  hbx.strokeStyle = g;
  hbx.lineWidth = 2;
  hbx.lineJoin = 'round';
  hbx.shadowColor = '#7c5cff';
  hbx.shadowBlur = 8;
  hbx.beginPath();
  hbData.forEach((v, i) => { const x = (i / (hbData.length - 1)) * 168; const y = 18 - v * 15; i ? hbx.lineTo(x, y) : hbx.moveTo(x, y); });
  hbx.stroke();
  requestAnimationFrame(drawHb);
}
requestAnimationFrame(drawHb);

/* ------------------------------------------------------------------ top bar */
const topRefs = {};
function buildTop() {
  const mk = (key, label, cls = '') => {
    const b = el('b', {}, '—');
    const s = el('div', { class: 'stat ' + cls }, b, el('span', {}, label));
    topRefs[key] = b;
    return s;
  };
  const credits = el('div', { class: 'stat opt' }, el('b', {}, '—'), el('div', { class: 'meter' }, el('i')));
  topRefs.credits = credits;
  $('#stats').append(mk('sol', 'SOL price'), mk('ev', 'events per second'), mk('tracked', 'tokens tracked', 'opt'), credits);
  $('#kill').addEventListener('click', async () => {
    const on = !(S.paper?.enabled ?? true);
    const r = await post('/api/paper/toggle', { enabled: on });
    if (r.ok) { S.paper = r.paper; renderEquity(); refreshTradeUI(); toast(on ? 'Trading enabled' : 'Kill switch on', on ? 'New paper buys are allowed.' : 'New buys are blocked. Exits stay available.', on ? 'good' : 'bad'); }
  });
}
function onStatus(st) {
  S.status = st;
  evRate = st.stream.evPerSec || 0;
  const pill = $('#modepill');
  if (st.mode === 'demo') { pill.className = 'pill demo'; pill.textContent = 'demo data'; }
  else if (st.stream.state === 'connected') { pill.className = 'pill live'; pill.textContent = 'live'; }
  else { pill.className = 'pill err'; pill.textContent = st.stream.state === 'connecting' ? 'connecting' : 'reconnecting'; }
  const banner = $('#banner');
  if (st.mode === 'demo') {
    banner.hidden = false;
    if (S.viewOnly) banner.textContent = 'View-only demo. Simulated market, nothing here is real, and trading is turned off.';
    else banner.textContent = st.demoReason === 'no-key'
      ? 'Simulated market. Nothing here is real. Set HELIUS_API_KEY (in .env locally, or as a variable on your host) and restart to switch to live pump.fun data.'
      : 'Simulated market (started with --demo). Nothing here is real.';
  } else if (st.stream.error) { banner.hidden = false; banner.textContent = 'Stream: ' + st.stream.error; }
  else if (st.rpc && st.rpc.ok === false) { banner.hidden = false; banner.textContent = 'RPC: ' + st.rpc.error; }
  else banner.hidden = true;
  if (st.solUsd && st.solUsd !== S.solUsd) { S.solUsd = st.solUsd; unitChanged(); }
  topRefs.sol.textContent = S.solUsd ? '$' + S.solUsd.toFixed(2) : 'n/a';
  topRefs.ev.textContent = evRate.toFixed(0);
  topRefs.tracked.textContent = st.tokens;
  const c = topRefs.credits;
  if (st.rpc) {
    const f = Math.min(1, st.rpc.used / st.rpc.budget);
    c.firstChild.textContent = `${compact(st.rpc.used)} / ${compact(st.rpc.budget)} credits`;
    c.querySelector('i').style.width = (f * 100).toFixed(1) + '%';
    c.title = 'Estimated Helius credits used this month. The Helius dashboard is the source of truth.';
  } else { c.firstChild.textContent = 'no RPC in demo'; c.querySelector('i').style.width = '0'; }
}
function renderEquity() {
  const p = S.paper;
  if (!p) return;
  const e = $('#equity');
  e.replaceChildren(el('b', {}, fmtSol(p.equity, 3) + ' SOL'), el('span', {}, 'paper equity' + (S.solUsd ? ' · $' + compact(p.equity * S.solUsd) : '')));
  const k = $('#kill');
  k.className = 'kill ' + (p.enabled ? 'on' : 'off');
  k.textContent = p.enabled ? 'Buys enabled' : 'Kill switch on';
}

/* ------------------------------------------------------------------ board */
function matchTab(t, tab, now) {
  switch (tab) {
    case 'new': return !t.partial && !t.complete && now - t.createdAt < 20 * 60_000;
    case 'hot': return !t.complete && now - t.lastTradeAt < 120_000 && t.v5 > 0;
    case 'final': return !t.complete && t.prog >= 0.7;
    case 'grad': return t.complete;
  }
}
const SORT = {
  new: (a, b) => b.createdAt - a.createdAt,
  hot: (a, b) => b.v5 - a.v5,
  final: (a, b) => b.prog - a.prog,
  grad: (a, b) => b.lastTradeAt - a.lastTradeAt,
};
function buildBoardTabs() {
  const box = $('#boardTabs');
  box.replaceChildren(...BOARD_TABS.map(([id, label]) => el('button', { class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'data-id': id, onclick: () => { S.tab = id; store.set('tab', id); renderBoard(true); } }, label, el('span', { class: 'n' }, ''))));
}
function makeRow(t) {
  const r = el('div', { class: 'row fresh', role: 'button', tabindex: '0' });
  const sym = el('span', { class: 'sym' });
  const nm = el('span', { class: 'nm' });
  const ago = el('span', { class: 'ago' });
  const vol = el('span');
  const hold = el('span');
  const tags = el('span');
  const mc = el('span', { class: 'mc' });
  const chg = el('span', { class: 'chg' });
  const rk = el('span', { class: 'rk' });
  const prog = el('div', { class: 'prog' }, el('i'));
  const qb = el('div', { class: 'qbtns' }, [0.1, 0.5, 1].map((a) => el('button', { class: 'qb', title: `Paper buy ${a} SOL`, onclick: (e) => { e.stopPropagation(); quickBuy(t.mint, a); } }, String(a))));
  const av = avatar(t.mint, t.symbol);
  r.append(av, el('div', { class: 'rmain' }, el('div', { class: 'rtop' }, sym, nm, ago), el('div', { class: 'rbot' }, vol, hold, rk, tags)), el('div', { class: 'rright' }, mc, chg), prog, qb);
  r._r = { sym, nm, ago, vol, hold, tags, mc, chg, rk, prog: prog.firstChild, av, px: 0, mint: t.mint, letter: t.symbol };
  r.addEventListener('click', () => openToken(t.mint));
  r.addEventListener('keydown', (e) => { if (e.key === 'Enter') openToken(t.mint); });
  setTimeout(() => r.classList.remove('fresh'), 1500);
  return r;
}
function updateRow(r, t) {
  const x = r._r;
  const label = t.symbol || short(t.mint);
  if (x.sym.textContent !== label) x.sym.textContent = label;
  x.nm.textContent = t.name || '';
  x.ago.textContent = (t.partial ? 'seen ' : '') + age(Date.now() - t.createdAt);
  x.vol.replaceChildren(el('b', {}, t.v5.toFixed(1)), ' SOL');
  x.vol.title = 'Volume in the last 5 minutes';
  x.hold.textContent = t.holders + ' holders';
  const tg = [];
  if (t.bundled) tg.push(el('span', { class: 'tag bad', title: 'Several wallets bought in the creation slot' }, 'bundled'));
  if (t.dev === 'sold_all') tg.push(el('span', { class: 'tag bad', title: 'Creator sold everything' }, 'dev sold'));
  x.tags.replaceChildren(...tg);
  const mcText = fmtMc(t.mcap);
  if (x.mc.textContent !== mcText) {
    if (x.px && t.price !== x.px) { x.mc.classList.remove('flashu', 'flashd'); void x.mc.offsetWidth; x.mc.classList.add(t.price > x.px ? 'flashu' : 'flashd'); }
    x.mc.textContent = mcText;
  }
  x.px = t.price;
  if (t.chg5 == null) { x.chg.textContent = ''; } else { x.chg.textContent = sgn(t.chg5, 1) + '%'; x.chg.className = 'chg ' + (t.chg5 >= 0 ? 'up' : 'dn'); }
  x.rk.textContent = t.risk.level.toLowerCase();
  x.rk.className = 'rk ' + t.risk.level.toLowerCase();
  x.rk.title = `Risk score ${t.risk.score}/100`;
  x.prog.style.width = (t.prog * 100).toFixed(1) + '%';
  r.classList.toggle('hot', t.prog >= 0.85 || t.v5 > 60);
  r.classList.toggle('sel', t.mint === S.sel);
  if (t.symbol && x.letter !== t.symbol) { x.letter = t.symbol; x.av.firstChild.textContent = t.symbol[0].toUpperCase(); }
}
const matches = (t, q) => (t.symbol || '').toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q) || t.mint.toLowerCase().includes(q);

/* Keeps a list element in step with `arr`, reusing row elements. Each list owns its own row map. */
function syncList(list, rows, arr, force, emptyText, mk = makeRow, up = updateRow) {
  const order = arr.map((t) => t.mint);
  const prev = list._order || [];
  const same = !force && order.length === prev.length && order.every((m, i) => m === prev[i]);
  if (!same) {
    const keep = new Set(order);
    for (const [m, r] of rows) if (!keep.has(m)) { r.remove(); rows.delete(m); }
    list.querySelector('.empty')?.remove();
    arr.forEach((t, i) => {
      let r = rows.get(t.mint);
      if (!r) { r = mk(t); rows.set(t.mint, r); }
      if (list.children[i] !== r) list.insertBefore(r, list.children[i] || null);
    });
    if (!arr.length) list.append(el('div', { class: 'empty' }, emptyText));
    list._order = order;
  }
  for (const t of arr) up(rows.get(t.mint), t);
}

function renderBoard(force) {
  const now = Date.now();
  const q = S.search.trim().toLowerCase();
  const all = [...S.tokens.values()];
  if (S.view === 'dash') { renderLanes(all, now, force); return; }
  const counts = {};
  for (const [id] of BOARD_TABS) counts[id] = all.filter((t) => matchTab(t, id, now)).length;
  document.querySelectorAll('#boardTabs .tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.id === S.tab);
    b.querySelector('.n').textContent = counts[b.dataset.id] || '';
  });
  let arr = q ? all.filter((t) => matches(t, q)) : all.filter((t) => matchTab(t, S.tab, now));
  if (S.hideHigh) arr = arr.filter((t) => t.risk.level !== 'HIGH');
  arr.sort(q ? SORT.hot : SORT[S.tab]);
  syncList($('#list'), S.rows, arr.slice(0, 60), force, q ? 'No token matches that search.' : S.tab === 'grad' ? 'No token has graduated since launch yet.' : 'Nothing here yet. New launches appear as they happen.');
}

/* ------------------------------------------------------------------ dashboard swimlanes */
/* Each lane has its own search, quick-buy amount and filters. Filter values are kept as typed
   (strings) so inputs round-trip; "5k" and "1.2m" work. */
const FILTERS = [
  { k: 'mcMin', label: 'Market cap min', unit: 'mc' },
  { k: 'mcMax', label: 'Market cap max', unit: 'mc' },
  { k: 'volMin', label: 'Volume 5m min', unit: 'SOL' },
  { k: 'holdersMin', label: 'Holders min' },
  { k: 'top10Max', label: 'Top 10 max', unit: '%' },
  { k: 'ageMax', label: 'Age max', unit: 'min' },
  { k: 'progMin', label: 'Curve min', unit: '%' },
  { k: 'chgMin', label: '5m change min', unit: '%' },
];
const FLAGS = [['noHigh', 'Hide high risk'], ['noBundled', 'Hide bundled'], ['noDevSold', 'Hide dev sold']];
const PRESETS = {
  safe: { label: 'Sniper-safe', f: { holdersMin: '20', top10Max: '30', noBundled: true, noDevSold: true } },
  momentum: { label: 'Momentum', f: { volMin: '10', chgMin: '20', ageMax: '15' } },
  closing: { label: 'About to graduate', f: { progMin: '85', volMin: '5' } },
};
const LANES = [
  { id: 'new', title: 'New', tone: 'var(--plasma)', empty: 'Nothing new yet. Launches appear here as they happen.', presets: ['safe', 'momentum'] },
  { id: 'final', title: 'Final stretch', tone: 'var(--amber)', empty: 'No token is close to graduating right now.', presets: ['safe', 'closing'] },
  { id: 'grad', title: 'Graduated', tone: 'var(--buy)', empty: 'No token has graduated since launch yet.', presets: ['safe'] },
];
const lanecfg = store.get('lanecfg', {});
const cfgOf = (id) => (lanecfg[id] ||= { f: {}, q: '', amt: 0.1 });
const saveCfg = () => store.set('lanecfg', lanecfg);
const num = (v) => {
  if (v == null || v === '') return null;
  const m = String(v).trim().toLowerCase().replace(/[$,%\s]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
};
function passesFilters(t, now, f) {
  const mc = mcVal(t.mcap);
  const lo = (k, v) => { const n = num(f[k]); return n != null && !(v >= n); };
  const hi = (k, v) => { const n = num(f[k]); return n != null && !(v <= n); };
  if (lo('mcMin', mc) || hi('mcMax', mc)) return false;
  if (lo('volMin', t.v5) || lo('holdersMin', t.holders)) return false;
  if (num(f.top10Max) != null && (t.partial || hi('top10Max', t.top10 * 100))) return false; // partial tokens have no holder data
  if (hi('ageMax', (now - t.createdAt) / 60000)) return false;
  if (lo('progMin', t.prog * 100)) return false;
  if (num(f.chgMin) != null && (t.chg5 == null || lo('chgMin', t.chg5))) return false;
  if (f.noHigh && t.risk.level === 'HIGH') return false;
  if (f.noBundled && t.bundled) return false;
  if (f.noDevSold && t.dev === 'sold_all') return false;
  return true;
}
const filterCount = (f) => FILTERS.filter(({ k }) => num(f[k]) != null).length + FLAGS.filter(([k]) => f[k]).length;

/* ---- token card used in the lanes */
const tone = (cls, text, title) => el('span', { class: 'chip ' + cls, title }, text);
function makeCard(t) {
  const r = el('div', { class: 'tc fresh', role: 'button', tabindex: '0' });
  const x = {
    mint: t.mint, letter: t.symbol, px: 0,
    av: avatar(t.mint, t.symbol),
    bar: el('i'), mintTxt: el('small'),
    sym: el('b', { class: 'tcsym' }), nm: el('span', { class: 'tcnm' }),
    age: el('span', { class: 'chip age' }), holders: el('span', { class: 'tcm' }), flags: el('span', { class: 'tcflags' }),
    mc: el('b', { class: 'tcmc' }), vol: el('span'), tx: el('span'), chg: el('span', { class: 'tcchg' }),
    stats: el('div', { class: 'tcstats' }),
    buy: el('button', { type: 'button', class: 'tcbuy' }, '⚡'),
  };
  x.buy.addEventListener('click', (e) => { e.stopPropagation(); quickBuy(t.mint, x.amt()); });
  r.append(
    el('div', { class: 'tcav' }, x.av, el('div', { class: 'tcbar' }, x.bar), x.mintTxt),
    el('div', { class: 'tcmain' }, el('div', { class: 'tcl1' }, x.sym, x.nm), el('div', { class: 'tcl2' }, x.age, x.holders), x.flags),
    el('div', { class: 'tcright' }, x.mc, el('div', { class: 'tcsub' }, el('span', {}, 'Vol ', x.vol), el('span', {}, 'Tx ', x.tx)), x.chg),
    x.stats, x.buy);
  r._r = x;
  r.addEventListener('click', () => openToken(t.mint));
  r.addEventListener('keydown', (e) => { if (e.key === 'Enter') openToken(t.mint); });
  setTimeout(() => r.classList.remove('fresh'), 1500);
  return r;
}
function updateCard(r, t) {
  const x = r._r;
  x.amt = () => num(cfgOf(r._lane).amt) || 0.1;
  x.buy.title = `Paper buy ${x.amt()} SOL`;
  const label = t.symbol || short(t.mint);
  if (x.sym.textContent !== label) x.sym.textContent = label;
  x.nm.textContent = t.name || '';
  x.mintTxt.textContent = short(t.mint);
  x.bar.style.width = (t.prog * 100).toFixed(1) + '%';
  x.bar.parentNode.title = `Curve ${(t.prog * 100).toFixed(0)}% full`;
  const ageMs = Date.now() - t.createdAt;
  x.age.textContent = (t.partial ? 'seen ' : '') + age(ageMs);
  x.age.className = 'chip age' + (ageMs < 60_000 ? ' fresh' : '');
  x.holders.textContent = `${t.holders} holders`;
  const fl = [];
  if (t.risk.level !== 'LOW') fl.push(el('span', { class: 'rk ' + t.risk.level.toLowerCase(), title: `Risk score ${t.risk.score}/100` }, t.risk.level.toLowerCase() + ' risk'));
  x.flags.replaceChildren(...fl);
  const mcText = fmtMc(t.mcap);
  if (x.mc.textContent !== mcText) {
    if (x.px && t.price !== x.px) { x.mc.classList.remove('flashu', 'flashd'); void x.mc.offsetWidth; x.mc.classList.add(t.price > x.px ? 'flashu' : 'flashd'); }
    x.mc.textContent = mcText;
  }
  x.px = t.price;
  x.vol.textContent = t.v5.toFixed(1) + ' SOL';
  x.tx.textContent = String(t.n5);
  if (t.chg5 == null) x.chg.textContent = ''; else { x.chg.textContent = sgn(t.chg5, 1) + '%'; x.chg.className = 'tcchg ' + (t.chg5 >= 0 ? 'up' : 'dn'); }
  const top = t.partial ? tone('n', 'Top10 ?', 'Not enough data: first seen mid-life') : tone(t.top10 > 0.35 ? 'b' : t.top10 > 0.25 ? 'w' : 'g', 'Top10 ' + pct(t.top10, 0), 'Share held by the 10 biggest wallets');
  const dev = t.dev === 'sold_all' ? tone('b', 'Dev sold', 'Creator sold everything') : t.dev === 'holding' ? tone(t.devPct > 0.1 ? 'b' : t.devPct > 0.04 ? 'w' : 'g', 'Dev ' + pct(t.devPct, 0), 'Creator still holds this much') : t.dev === 'none' ? tone('g', 'Dev 0%', 'Creator holds none') : tone('n', 'Dev ?', 'Unknown');
  const snp = tone(t.snipers >= 5 ? 'b' : t.snipers >= 2 ? 'w' : 'g', `${t.snipers} ${t.snipers === 1 ? 'sniper' : 'snipers'}`, 'Wallets that bought in the first seconds');
  const bun = t.bundled ? tone('b', 'Bundled', 'Several wallets bought in the creation slot') : tone('g', 'No bundle', 'No bundled buys detected');
  const bp = t.buyPct5 == null ? tone('n', 'Buys —', 'No volume in the last 5 minutes') : tone(t.buyPct5 >= 0.55 ? 'g' : t.buyPct5 < 0.4 ? 'b' : 'w', 'Buys ' + pct(t.buyPct5, 0), 'Share of 5m volume that is buying');
  x.stats.replaceChildren(top, dev, snp, bun, bp);
  r.classList.toggle('hot', t.prog >= 0.85 || t.v5 > 60);
  r.classList.toggle('sel', t.mint === S.sel);
  if (t.symbol && x.letter !== t.symbol) { x.letter = t.symbol; x.av.firstChild.textContent = t.symbol[0].toUpperCase(); }
}

/* ---- lanes */
const laneRefs = {};
function buildLanes() {
  const box = $('#lanes');
  box.replaceChildren(...LANES.map((L) => {
    const c = cfgOf(L.id);
    const n = el('span', { class: 'n' }, '0');
    const search = el('input', { type: 'search', class: 'lsearch', placeholder: 'Search', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Search ${L.title}` });
    search.value = c.q || '';
    search.addEventListener('input', () => { c.q = search.value; saveCfg(); renderBoard(true); });
    const amt = el('input', { type: 'text', inputmode: 'decimal', class: 'lamt-in', 'aria-label': 'Quick-buy amount in SOL' });
    amt.value = c.amt;
    amt.addEventListener('input', () => { c.amt = amt.value; saveCfg(); });
    const badge = el('b', { class: 'badge', hidden: true }, '0');
    const fbtn = el('button', { type: 'button', class: 'lfilter', title: 'Filters for this lane', 'aria-label': `Filters for ${L.title}`, 'aria-expanded': 'false' }, el('svg', {}), badge);
    fbtn.firstChild.outerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 5h14M6 10h8M9 15h2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
    const head = el('header', { class: 'lh' }, el('h2', {}, el('i', { class: 'ldot' }), L.title, n), search, el('label', { class: 'lamt', title: 'Quick-buy amount (SOL) for the ⚡ button on each card' }, '⚡', amt), fbtn);
    const list = el('div', { class: 'lanelist scroll' });
    const pop = buildLanePop(L, c, () => { saveCfg(); updateLaneBadge(L.id); renderBoard(true); });
    const sec = el('section', { class: 'lane', style: `--tone:${L.tone}` }, head, pop.root, list);
    fbtn.addEventListener('click', (e) => { e.stopPropagation(); const open = pop.root.hidden; closePops(); pop.root.hidden = !open; fbtn.setAttribute('aria-expanded', String(open)); });
    laneRefs[L.id] = { n, list, rows: new Map(), badge, fbtn, pop, search, amt };
    updateLaneBadge(L.id);
    return sec;
  }));
}
function closePops() {
  for (const r of Object.values(laneRefs)) { r.pop.root.hidden = true; r.fbtn.setAttribute('aria-expanded', 'false'); }
}
function updateLaneBadge(id) {
  const r = laneRefs[id];
  const n = filterCount(cfgOf(id).f);
  r.badge.hidden = !n;
  r.badge.textContent = String(n);
  r.fbtn.classList.toggle('on', n > 0);
  r.pop.sync();
}
function buildLanePop(L, c, changed) {
  const inputs = {}, flags = {};
  const fields = FILTERS.map(({ k, label, unit }) => {
    const input = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: 'any', 'aria-label': `${label} (${L.title})` });
    input.value = c.f[k] ?? '';
    input.addEventListener('input', () => { if (input.value.trim()) c.f[k] = input.value; else delete c.f[k]; changed(); });
    const u = el('i', {}, unit && unit !== 'mc' ? unit : '');
    inputs[k] = { input, u, unit };
    return el('label', { class: 'ff' }, el('span', {}, label), el('div', { class: 'fi' }, input, u));
  });
  const flagEls = FLAGS.map(([k, label]) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = Boolean(c.f[k]);
    cb.addEventListener('change', () => { if (cb.checked) c.f[k] = true; else delete c.f[k]; changed(); });
    flags[k] = cb;
    return el('label', { class: 'toggle' }, cb, el('span', {}, label));
  });
  const apply = (f) => { c.f = { ...f }; changed(); };
  const presets = el('div', { class: 'fpresets' }, L.presets.map((id) => el('button', { type: 'button', class: 'fp', title: Object.entries(PRESETS[id].f).map(([k, v]) => `${k}: ${v}`).join(', '), onclick: () => apply(PRESETS[id].f) }, PRESETS[id].label)));
  const clear = el('button', { type: 'button', class: 'fclear', onclick: () => apply({}) }, 'Clear');
  const root = el('div', { class: 'lpop', hidden: true, role: 'dialog', 'aria-label': `${L.title} filters` },
    el('div', { class: 'fgrid' }, fields), el('div', { class: 'fflags' }, flagEls), el('div', { class: 'fbot' }, presets, clear));
  root.addEventListener('click', (e) => e.stopPropagation());
  return {
    root,
    sync() {
      for (const [k, r] of Object.entries(inputs)) { if (document.activeElement !== r.input) r.input.value = c.f[k] ?? ''; if (r.unit === 'mc') r.u.textContent = useUsd() ? '$' : 'SOL'; }
      for (const [k, cb] of Object.entries(flags)) cb.checked = Boolean(c.f[k]);
      clear.disabled = !filterCount(c.f);
    },
  };
}
function updateLaneUnits() { for (const L of LANES) if (laneRefs[L.id]) laneRefs[L.id].pop.sync(); }
function renderLanes(all, now, force) {
  for (const L of LANES) {
    const c = cfgOf(L.id);
    const q = (c.q || '').trim().toLowerCase();
    let arr = all.filter((t) => matchTab(t, L.id, now));
    if (L.id === 'new') arr = arr.filter((t) => t.prog < 0.7); // a token near graduation lives in Final stretch only
    if (q) arr = arr.filter((t) => matches(t, q));
    if (filterCount(c.f)) arr = arr.filter((t) => passesFilters(t, now, c.f));
    arr.sort(SORT[L.id]);
    const ref = laneRefs[L.id];
    ref.n.textContent = arr.length > 40 ? '40+' : String(arr.length);
    syncList(ref.list, ref.rows, arr.slice(0, 40), force, q ? 'No token matches that search.' : filterCount(c.f) ? 'No token matches this lane\'s filters. Loosen or clear them.' : L.empty,
      (t) => { const r = makeCard(t); r._lane = L.id; return r; }, updateCard);
  }
}
function setView(v, mint) {
  S.view = v === 'trade' ? 'trade' : 'dash';
  store.set('view', S.view);
  $('#dash').hidden = S.view !== 'dash';
  $('#layout').hidden = S.view !== 'trade';
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  if (mint) select(mint);
  renderBoard(true);
}
function openToken(mint) {
  // With the quick-trade window open on the dashboard, a click just picks the token so you can trade it in place.
  if (S.view !== 'trade' && !(Q.root && !Q.root.hidden)) setView('trade', mint); else select(mint);
}

/* ------------------------------------------------------------------ token header */
let head = null;
function buildHead(t) {
  const box = $('#thead');
  const sym = el('span', {}, t.symbol || short(t.mint));
  const nm = el('small', {}, t.name || '');
  const rk = el('span', { class: 'rk' });
  const age_ = el('span');
  const links = el('span');
  const mintBtn = el('button', { class: 'copy', title: 'Copy mint address', onclick: () => { copyText(t.mint); toast('Mint copied', short(t.mint)); } }, short(t.mint));
  const scan = el('a', { class: 'lnk', href: 'https://solscan.io/token/' + t.mint, target: '_blank', rel: 'noopener noreferrer' }, 'Solscan');
  const mcEl = el('b', {}, '');
  const chgEl = el('span', {}, '');
  const desc = el('div', { class: 'desc' });
  const M = {};
  const metric = (k, l) => { const b = el('b', {}, '—'); M[k] = b; return el('div', { class: 'metric' }, el('span', {}, l), b); };
  const av = el('div', { class: 'av-slot' }, avatar(t.mint, t.symbol));
  av.style.display = 'contents';
  box.replaceChildren(av, el('div', { class: 'tinfo' }, el('div', { class: 'tname' }, sym, nm, rk), el('div', { class: 'tsub' }, mintBtn, age_, scan, links)), el('div', { class: 'tprice' }, mcEl, chgEl),
    el('div', { class: 'metrics' }, metric('price', 'Price'), metric('vol', 'Volume 5m'), metric('tx', 'Buys / sells'), metric('holders', 'Holders'), metric('top10', 'Top 10 hold'), metric('prog', 'Curve progress'), metric('ath', 'All-time high'), metric('dev', 'Dev')), desc);
  head = { sym, nm, rk, age_, links, mcEl, chgEl, M, desc, av, mint: t.mint };
}
const DEV_TEXT = { sold_all: 'sold all', sold_some: 'selling', holding: 'holding', none: 'holds none', unknown: 'unknown' };
function updateHead(t) {
  if (!head || head.mint !== t.mint) return;
  head.sym.textContent = t.symbol || short(t.mint);
  head.nm.textContent = t.name || '';
  head.rk.textContent = t.risk.level.toLowerCase() + ' risk';
  head.rk.className = 'rk ' + t.risk.level.toLowerCase();
  head.age_.textContent = (t.partial ? 'first seen ' : 'launched ') + age(Date.now() - t.createdAt) + ' ago';
  head.mcEl.textContent = fmtMc(t.mcap);
  head.chgEl.textContent = t.chg5 == null ? '' : sgn(t.chg5, 1) + '% (5m)';
  head.chgEl.className = t.chg5 == null ? '' : t.chg5 >= 0 ? 'up' : 'dn';
  const M = head.M;
  M.price.textContent = useUsd() ? '$' + fmtPrice(t.price * S.solUsd) : fmtPrice(t.price) + ' SOL';
  M.vol.textContent = t.v5.toFixed(1) + ' SOL';
  M.tx.textContent = `${t.buys} / ${t.sells}`;
  M.holders.textContent = t.holders + (t.partial ? '+' : '');
  M.top10.textContent = t.partial ? 'partial data' : pct(t.top10, 0);
  M.prog.textContent = t.complete ? 'graduated' : pct(t.prog, 1);
  M.ath.textContent = fmtMc(t.ath);
  M.dev.textContent = DEV_TEXT[t.dev] + (t.dev === 'holding' ? ' ' + pct(t.devPct, 1) : '');
}
async function loadMeta(mint) {
  const r = await getJson('/api/meta/' + mint).catch(() => null);
  if (!r?.ok || S.sel !== mint || !head) return;
  S.meta = r.meta;
  head.desc.textContent = r.meta.description || '';
  const ls = [];
  for (const [k, label] of [['twitter', 'X'], ['telegram', 'Telegram'], ['website', 'Website']]) {
    const u = r.meta[k];
    if (u && u.startsWith('https://')) ls.push(el('a', { class: 'lnk', href: u, target: '_blank', rel: 'noopener noreferrer nofollow', title: u }, label));
  }
  head.links.replaceChildren(...ls.flatMap((a, i) => (i ? [' ', a] : [a])));
  if (r.meta.imageCid) {
    const t = S.tokens.get(mint);
    head.av.replaceChildren(avatar(mint, t?.symbol, r.meta.imageCid));
  }
}
function copyText(s) {
  if (navigator.clipboard) navigator.clipboard.writeText(s).catch(() => {});
}

/* ------------------------------------------------------------------ chart */
let chart;
function chartOpts() {
  const d = S.detail;
  const pos = S.paper?.positions.find((p) => p.mint === S.sel);
  return { mult: d ? d.supply * (useUsd() ? S.solUsd : 1) : 1, fmt: fmtAxis, entry: pos?.entryMcap ? mcVal(pos.entryMcap) : null };
}
function buildChartBar() {
  const bar = $('#chartbar');
  const iv = el('div', { class: 'seg' }, Object.keys(STEP).map((k) => el('button', { class: S.interval === k ? 'on' : '', onclick: (e) => { S.interval = k; store.set('interval', k); iv.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); if (S.detail) chart.setData(S.detail.candles[k], STEP[k], chartOpts()); } }, k)));
  const un = el('div', { class: 'seg' }, [['usd', 'USD'], ['sol', 'SOL']].map(([k, l]) => el('button', { class: S.unit === k ? 'on' : '', onclick: (e) => { S.unit = k; store.set('unit', k); un.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); unitChanged(); } }, l)));
  bar.replaceChildren(iv, un, el('span', { class: 'ml' }, 'Scroll to zoom, drag to pan, double-click for live'));
}
function unitChanged() {
  if (S.detail) chart.setStyle(chartOpts());
  const t = S.tokens.get(S.sel);
  if (t) updateHead(t);
  updateLaneUnits();
  renderBoard(true);
  renderEquity();
  if (S.dock === 'trades') redrawTrades();
}

/* ------------------------------------------------------------------ select */
async function select(mint) {
  if (!mint) return;
  S.sel = mint;
  try { history.replaceState(null, '', '#' + mint); } catch { /* ignore */ }
  document.querySelectorAll('.row').forEach((r) => r.classList.toggle('sel', r._r.mint === mint));
  const d = await getJson(`/api/token/${mint}?cid=${S.cid}`).catch(() => null);
  if (S.sel !== mint) return;
  if (!d?.ok) { toast('Token unavailable', 'It may have been dropped from memory. Pick another one.', 'bad'); return; }
  S.detail = d;
  S.meta = null;
  S.lastSeq = d.seq;
  S.trades = d.trades.slice().reverse();
  const t = S.tokens.get(mint) || d.summary;
  $('#chartEmpty').hidden = true;
  buildHead(t);
  updateHead(d.summary);
  chart.setData(d.candles[S.interval], STEP[S.interval], chartOpts());
  renderDock(true);
  renderRisk(d.risk);
  refreshTradeUI();
  refreshQuote();
  renderPositions();
  loadMeta(mint);
}

/* ------------------------------------------------------------------ dock */
let dockRefs = {};
function buildDockTabs() {
  const box = $('#dockTabs');
  box.replaceChildren(...DOCK_TABS.map(([id, label]) => el('button', { class: 'tab' + (S.dock === id ? ' on' : ''), role: 'tab', 'data-id': id, onclick: () => { S.dock = id; store.set('dock', id); if (id === 'alerts') { S.unread = 0; } renderDock(true); updateDockTabs(); } }, label, id === 'alerts' ? el('span', { class: 'badge', hidden: true }, '0') : null)));
  updateDockTabs();
}
function updateDockTabs() {
  document.querySelectorAll('#dockTabs .tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.id === S.dock);
    const bg = b.querySelector('.badge');
    if (bg) { bg.hidden = !S.unread; bg.textContent = S.unread; }
  });
}
function tradeRow(t, isNew) {
  return el('tr', { class: isNew ? 'new' : '' }, el('td', { class: 'dim' }, clock(t.t)), el('td', {}, el('span', { class: 'sidepill ' + (t.s ? 'b' : 's') }, t.s ? 'buy' : 'sell')), el('td', { class: 'r ' + (t.s ? 'up' : 'dn') }, t.sol.toFixed(3)), el('td', { class: 'r dim' }, compact(t.tok)), el('td', { class: 'r' }, fmtMc(t.mc)), el('td', { class: 'mono dim', title: t.w }, short(t.w)));
}
function redrawTrades() {
  if (S.dock !== 'trades' || !dockRefs.tbody) return;
  dockRefs.tbody.replaceChildren(...S.trades.slice(0, 60).map((t) => tradeRow(t, false)));
}
function renderHolders(list) {
  if (S.dock !== 'holders') return;
  const box = $('#dockBody');
  if (!S.sel) { box.replaceChildren(el('div', { class: 'empty' }, 'Select a token to see its holders.')); return; }
  const rows = list.map((h, i) => el('tr', {}, el('td', { class: 'dim' }, i + 1), el('td', { class: 'mono', title: h.wallet }, short(h.wallet)), el('td', { class: 'r' }, pct(h.pct, 2)), el('td', {}, el('div', { class: 'meter', style: 'width:90px;margin:0' }, el('i', { style: `width:${Math.min(100, h.pct * 400)}%` }))), el('td', {}, h.dev ? el('span', { class: 'tag' }, 'dev') : null, ' ', h.sniper ? el('span', { class: 'tag bad' }, 'sniper') : null)));
  box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Wallet'), el('th', { class: 'r' }, 'Supply'), el('th', {}, ''), el('th', {}, ''))), el('tbody', {}, rows)));
  if (S.detail?.partialNote) { /* reserved */ }
}
function renderWatch() {
  const box = dockRefs.watch;
  if (!box) return;
  const rows = S.watch.map((w) => {
    const p = w.stats;
    return el('tr', {}, el('td', {}, w.label), el('td', { class: 'mono', title: w.wallet }, short(w.wallet)), el('td', { class: 'r ' + (p && p.realized >= 0 ? 'up' : 'dn') }, p ? sgn(p.realized, 2) + ' SOL' : '—'), el('td', { class: 'r' }, p && p.winRate != null ? pct(p.winRate, 0) : '—'), el('td', { class: 'r' }, el('button', { class: 'mini x', onclick: async () => { const r = await post('/api/unwatch', { wallet: w.wallet }); if (r.ok) { S.watch = r.watch; renderWatch(); } } }, 'Remove')));
  });
  box.replaceChildren(el('div', { class: 'sub' }, `Watching ${S.watch.length}. Their trades alert you in real time.`), S.watch.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Label'), el('th', {}, 'Wallet'), el('th', { class: 'r' }, 'Realized'), el('th', { class: 'r' }, 'Win rate'), el('th', {}, ''))), el('tbody', {}, rows)) : el('div', { class: 'empty' }, 'No wallets yet. Add one above, or watch one from the list below.'));
}
function renderTop() {
  const box = dockRefs.top;
  if (!box) return;
  const watched = new Set(S.watch.map((w) => w.wallet));
  const rows = S.top.map((r) => el('tr', {}, el('td', { class: 'mono', title: r.wallet }, short(r.wallet), r.fast ? el('span', { class: 'tag', title: 'Average hold under 4 seconds: likely a bot' }, ' bot-like') : null), el('td', { class: 'r up' }, sgn(r.realized, 2) + ' SOL'), el('td', { class: 'r' }, pct(r.winRate, 0)), el('td', { class: 'r' }, r.closed), el('td', { class: 'r' }, el('button', { class: 'mini', disabled: watched.has(r.wallet), onclick: async () => { const l = prompt('Label for this wallet', 'Smart wallet'); if (l === null) return; const x = await post('/api/watch', { wallet: r.wallet, label: l }); if (x.ok) { S.watch = x.watch; renderWatch(); renderTop(); } } }, watched.has(r.wallet) ? 'Watching' : 'Watch'))));
  box.replaceChildren(el('div', { class: 'sub' }, 'Best realized PnL since launch (needs 2+ closed positions). Built from the live stream, so it grows as you leave the terminal open.'), S.top.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Wallet'), el('th', { class: 'r' }, 'Realized'), el('th', { class: 'r' }, 'Win rate'), el('th', { class: 'r' }, 'Closed'), el('th', {}, ''))), el('tbody', {}, rows)) : el('div', { class: 'empty' }, 'Nothing ranked yet. Wallets appear once they close a couple of profitable positions.'));
}
async function pollTop() {
  if (S.dock !== 'wallets') return;
  const r = await getJson('/api/wallets/top').catch(() => null);
  if (r?.ok) { S.top = r.rows; renderTop(); }
  const w = await getJson('/api/watch').catch(() => null);
  if (w?.ok) { S.watch = w.watch; renderWatch(); }
}
function renderAlerts() {
  if (S.dock !== 'alerts') return;
  const box = $('#dockBody');
  if (!S.alerts.length) { box.replaceChildren(el('div', { class: 'empty' }, 'No alerts yet. Trades by wallets you watch show up here.')); return; }
  box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Wallet'), el('th', {}, 'Action'), el('th', {}, 'Token'), el('th', { class: 'r' }, 'SOL'), el('th', { class: 'r' }, 'Market cap'))), el('tbody', {}, S.alerts.slice(0, 80).map((a) => el('tr', { class: 'click', onclick: () => select(a.mint) }, el('td', { class: 'dim' }, clock(a.t)), el('td', {}, a.label), el('td', {}, el('span', { class: 'sidepill ' + (a.side === 'buy' ? 'b' : 's') }, a.side)), el('td', {}, a.symbol || short(a.mint)), el('td', { class: 'r ' + (a.side === 'buy' ? 'up' : 'dn') }, a.sol.toFixed(3)), el('td', { class: 'r' }, fmtMc(a.mc)))))));
}
function renderDock() {
  const box = $('#dockBody');
  dockRefs = {};
  if (S.dock === 'trades') {
    if (!S.sel) { box.replaceChildren(el('div', { class: 'empty' }, 'Select a token to watch its trades.')); return; }
    const tbody = el('tbody');
    box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Side'), el('th', { class: 'r' }, 'SOL'), el('th', { class: 'r' }, 'Tokens'), el('th', { class: 'r' }, 'Market cap'), el('th', {}, 'Wallet'))), tbody));
    dockRefs.tbody = tbody;
    redrawTrades();
  } else if (S.dock === 'holders') {
    renderHolders(S.detail?.holders || []);
  } else if (S.dock === 'wallets') {
    const wallet = el('input', { type: 'text', placeholder: 'Wallet address', spellcheck: 'false', autocomplete: 'off', maxlength: '44' });
    const label = el('input', { type: 'text', placeholder: 'Label', maxlength: '32' });
    const add = el('button', { class: 'mini', onclick: async () => { const r = await post('/api/watch', { wallet: wallet.value.trim(), label: label.value }); if (r.ok) { S.watch = r.watch; wallet.value = ''; label.value = ''; renderWatch(); renderTop(); } else toast('Could not add wallet', r.error, 'bad'); } }, 'Watch');
    dockRefs.watch = el('div');
    dockRefs.top = el('div');
    box.replaceChildren(el('div', { class: 'addwallet' }, wallet, label, add), dockRefs.watch, dockRefs.top);
    renderWatch(); renderTop(); pollTop();
  } else renderAlerts();
}

/* ------------------------------------------------------------------ trade card */
const T = {};
function buildTrade() {
  const card = $('#tradeCard');
  T.side = el('div', { class: 'seg', style: 'display:flex' }, ['buy', 'sell'].map((k) => el('button', { style: 'flex:1', class: S.side === k ? 'on' : '', onclick: () => { S.side = k; tradeSide(); } }, k === 'buy' ? 'Buy' : 'Sell')));
  T.presets = el('div', { class: 'presets' });
  T.amt = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': 'Amount' });
  T.tp = el('input', { type: 'number', min: '0', step: '10', 'aria-label': 'Take profit percent' });
  T.sl = el('input', { type: 'number', min: '0', max: '99', step: '5', 'aria-label': 'Stop loss percent' });
  T.fields = el('div', { class: 'fields' }, el('label', { class: 'field' }, 'Amount (SOL)', T.amt), el('label', { class: 'field' }, 'Take profit %', T.tp), el('label', { class: 'field' }, 'Stop loss %', T.sl));
  T.amtLabel = T.fields.firstChild.firstChild;
  T.quote = el('div', { class: 'quote' });
  T.btn = el('button', { class: 'btn buy', onclick: execTrade }, 'Buy');
  T.note = el('div', { class: 'note' });
  card.replaceChildren(el('h3', {}, 'Trade', el('span', { class: 'papertag', title: 'Simulated fills on the real curve. No wallet, no funds.' }, 'paper')), T.side, T.presets, T.fields, T.quote, T.btn, T.note);
  T.tp.value = S.tp; T.sl.value = S.sl;
  T.tp.addEventListener('input', () => { S.tp = Number(T.tp.value) || 0; store.set('tp', S.tp); });
  T.sl.addEventListener('input', () => { S.sl = Number(T.sl.value) || 0; store.set('sl', S.sl); });
  T.amt.addEventListener('input', () => { if (S.side === 'buy') { S.buyAmt = Number(T.amt.value) || 0; store.set('buyAmt', S.buyAmt); } else S.sellPct = Number(T.amt.value) || 0; markPresets(); refreshQuote(); });
  tradeSide();
}
function tradeSide() {
  const buy = S.side === 'buy';
  T.side.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 0) === buy));
  T.side.className = 'seg ' + S.side;
  T.btn.className = 'btn ' + S.side;
  const vals = buy ? [0.1, 0.25, 0.5, 1] : [25, 50, 75, 100];
  T.presets.replaceChildren(...vals.map((v) => el('button', { 'data-v': v, onclick: () => { if (buy) { S.buyAmt = v; store.set('buyAmt', v); } else S.sellPct = v; T.amt.value = v; markPresets(); refreshQuote(); } }, buy ? String(v) : v + '%')));
  T.amt.value = buy ? S.buyAmt : S.sellPct;
  T.amtLabel.textContent = buy ? 'Amount (SOL)' : 'Sell percent';
  T.fields.children[1].style.display = T.fields.children[2].style.display = buy ? '' : 'none';
  T.fields.style.gridTemplateColumns = buy ? '1fr 1fr 1fr' : '1fr';
  markPresets();
  refreshTradeUI();
  refreshQuote();
}
function markPresets() {
  const cur = Number(T.amt.value);
  T.presets.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === cur));
}
function refreshTradeUI() {
  const t = S.tokens.get(S.sel);
  const pos = S.paper?.positions.find((p) => p.mint === S.sel);
  const buy = S.side === 'buy';
  let label = buy ? 'Buy' : 'Sell';
  let dis = false;
  if (!t) { dis = true; label = 'Select a token'; }
  else if (buy && t.complete) { dis = true; label = 'Graduated: curve closed'; }
  else if (buy && S.paper && !S.paper.enabled) { dis = true; label = 'Kill switch is on'; }
  else if (!buy && !pos) { dis = true; label = 'No position to sell'; }
  else label = (buy ? 'Buy ' : 'Sell ') + (t.symbol || short(t.mint));
  T.btn.disabled = dis;
  T.btn.textContent = label;
  const L = S.paper?.limits;
  updateQuick();
  T.note.textContent = L ? `Limits: ${L.maxPositionSol} SOL per token, ${L.maxOpen} positions, ${L.dailyLossCapSol} SOL daily loss cap. Fills include fees, ${(L.slippageBps / 100).toFixed(1)}% slippage and a ${L.priorityFeeSol} SOL priority fee.` : '';
}
let qTimer = null;
function refreshQuote() {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const t = S.tokens.get(S.sel);
    const box = T.quote;
    if (!t) { box.replaceChildren(el('div', {}, 'Pick a token to see a quote.')); return; }
    const buy = S.side === 'buy';
    const amt = Number(T.amt.value);
    if (!(amt > 0)) { box.replaceChildren(el('div', {}, 'Enter an amount.')); return; }
    const q = await getJson(`/api/quote?mint=${S.sel}&side=${S.side}&${buy ? 'sol=' + amt : 'pct=' + amt}`).catch(() => null);
    if (!q?.ok) { box.replaceChildren(el('div', {}, q?.error || 'No quote available.')); return; }
    const x = q.quote;
    const row = (l, v) => el('div', {}, l, el('b', {}, v));
    if (buy) box.replaceChildren(row('You receive', '≈ ' + compact(x.tokens) + ' ' + (t.symbol || '')), row('Price impact', x.impactPct.toFixed(2) + '%'), row('Fees', fmtSol(x.feeSol + x.txFeeSol, 4) + ' SOL'));
    else box.replaceChildren(row('You receive', '≈ ' + fmtSol(x.proceeds, 4) + ' SOL'), row('Estimated PnL', (x.pnl >= 0 ? '+' : '') + fmtSol(x.pnl, 4) + ' SOL'), row('Price impact', x.impactPct.toFixed(2) + '%'));
  }, 120);
}
async function execTrade() {
  const t = S.tokens.get(S.sel);
  if (!t) return;
  T.btn.disabled = true;
  const sym = t.symbol || short(t.mint);
  if (S.side === 'buy') {
    const r = await post('/api/paper/buy', { mint: S.sel, sol: Number(T.amt.value), tp: S.tp || null, sl: S.sl || null });
    if (r.ok) { S.paper = r.paper; toast('Bought ' + sym, `${fmtSol(r.fill.spent, 3)} SOL for ${compact(r.fill.tokens)} tokens`, 'good'); } else toast('Buy blocked', r.error, 'bad');
  } else {
    const r = await post('/api/paper/sell', { mint: S.sel, pct: Number(T.amt.value) });
    if (r.ok) { S.paper = r.paper; toast('Sold ' + sym, `${fmtSol(r.fill.proceeds, 3)} SOL, PnL ${sgn(r.fill.pnl, 3)}`, r.fill.pnl >= 0 ? 'good' : 'bad'); } else toast('Sell blocked', r.error, 'bad');
  }
  onPaper();
}
async function quickBuy(mint, sol) {
  const t = S.tokens.get(mint);
  const r = await post('/api/paper/buy', { mint, sol, tp: S.tp || null, sl: S.sl || null });
  if (r.ok) { S.paper = r.paper; toast('Bought ' + (t?.symbol || short(mint)), `${fmtSol(r.fill.spent, 3)} SOL`, 'good'); onPaper(); } else toast('Buy blocked', r.error, 'bad');
}
/* ------------------------------------------------------------------ quick trade (floating window) */
const Q = { busy: false, edit: false, buy: store.get('qbuy', [0.1, 0.25, 0.5, 1]), sell: store.get('qsell', [100, 75, 50, 10]), pos: store.get('qpos', null) };
function buildQuick() {
  const root = el('div', { class: 'qt', id: 'qt', role: 'dialog', 'aria-label': 'Quick trade', hidden: true });
  Q.root = root;
  Q.sym = el('b', {}, 'No token');
  Q.px = el('span', { class: 'qpx' });
  Q.edit_ = el('button', { type: 'button', class: 'qicon', title: 'Edit preset amounts', 'aria-label': 'Edit presets', onclick: () => toggleQuickEdit() }, '✎');
  const close = el('button', { type: 'button', class: 'qicon', title: 'Close (Esc)', 'aria-label': 'Close quick trade', onclick: () => setQuick(false) }, '✕');
  Q.head = el('div', { class: 'qt-head' }, el('span', { class: 'qgrip', 'aria-hidden': 'true' }, '⠿'), Q.sym, Q.px, el('span', { class: 'fsp' }), Q.edit_, close);
  Q.bal = el('span', { class: 'qbal' });
  Q.pos_ = el('span', { class: 'qbal' });
  Q.buyGrid = el('div', { class: 'qgrid buy' });
  Q.sellGrid = el('div', { class: 'qgrid sell' });
  const tp = el('input', { type: 'number', min: '0', step: '10', 'aria-label': 'Take profit percent' });
  const sl = el('input', { type: 'number', min: '0', max: '99', step: '5', 'aria-label': 'Stop loss percent' });
  tp.value = S.tp; sl.value = S.sl;
  tp.addEventListener('input', () => { S.tp = Number(tp.value) || 0; store.set('tp', S.tp); if (T.tp) T.tp.value = S.tp; });
  sl.addEventListener('input', () => { S.sl = Number(sl.value) || 0; store.set('sl', S.sl); if (T.sl) T.sl.value = S.sl; });
  Q.tp = tp; Q.sl = sl;
  Q.fees = el('span', { class: 'qfee' });
  Q.note = el('div', { class: 'qnote' });
  root.append(Q.head,
    el('div', { class: 'qt-sec' }, el('div', { class: 'qtitle buy' }, el('span', {}, 'Buy (SOL)'), Q.bal), Q.buyGrid,
      el('div', { class: 'qmeta' }, el('label', {}, 'TP', tp, '%'), el('label', {}, 'SL', sl, '%'), Q.fees)),
    el('div', { class: 'qt-sec' }, el('div', { class: 'qtitle sell' }, el('span', {}, 'Sell %'), Q.pos_), Q.sellGrid),
    Q.note);
  document.body.append(root);
  renderQuickButtons();
  // Drag by the header. The position is remembered and always clamped back onto the screen.
  Q.head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = root.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    Q.head.setPointerCapture(e.pointerId);
    const move = (ev) => placeQuick(ev.clientX - dx, ev.clientY - dy);
    const up = () => { Q.head.removeEventListener('pointermove', move); Q.head.removeEventListener('pointerup', up); const b = root.getBoundingClientRect(); store.set('qpos', { x: b.left, y: b.top }); };
    Q.head.addEventListener('pointermove', move);
    Q.head.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', () => { if (!root.hidden) { const b = root.getBoundingClientRect(); placeQuick(b.left, b.top); } });
}
function placeQuick(x, y) {
  const r = Q.root.getBoundingClientRect();
  const nx = Math.max(6, Math.min(window.innerWidth - r.width - 6, x));
  const ny = Math.max(6, Math.min(window.innerHeight - 60, y));
  Q.root.style.left = nx + 'px';
  Q.root.style.top = ny + 'px';
}
function setQuick(on) {
  Q.root.hidden = !on;
  document.querySelector('#qtBtn')?.classList.toggle('on', on);
  if (on) {
    Q.root.style.left = '0px'; Q.root.style.top = '0px'; // measure first, then place
    const d = Q.pos || { x: window.innerWidth - 372, y: 110 };
    placeQuick(d.x, d.y);
    updateQuick();
  }
}
function toggleQuickEdit() {
  if (Q.edit) {
    const read = (grid, lo, hi) => [...grid.querySelectorAll('input')].map((i) => Number(i.value)).map((n) => Math.min(hi, Math.max(lo, n || lo)));
    Q.buy = read(Q.buyGrid, 0.001, 1000).map((n) => Math.round(n * 1000) / 1000);
    Q.sell = read(Q.sellGrid, 1, 100).map(Math.round);
    store.set('qbuy', Q.buy); store.set('qsell', Q.sell);
  }
  Q.edit = !Q.edit;
  Q.edit_.classList.toggle('on', Q.edit);
  Q.edit_.textContent = Q.edit ? '✓' : '✎';
  Q.edit_.title = Q.edit ? 'Save presets' : 'Edit preset amounts';
  renderQuickButtons();
}
function renderQuickButtons() {
  const cell = (v, suffix, side) => {
    if (Q.edit) {
      const i = el('input', { type: 'number', step: side === 'buy' ? '0.01' : '5', min: '0', 'aria-label': side + ' preset' });
      i.value = v;
      return i;
    }
    return el('button', { type: 'button', class: 'qbtn', 'data-v': v, onclick: () => quickTrade(side, v) }, String(v) + suffix);
  };
  Q.buyGrid.replaceChildren(...Q.buy.map((v) => cell(v, '', 'buy')));
  Q.sellGrid.replaceChildren(...Q.sell.map((v) => cell(v, '%', 'sell')));
  updateQuick();
}
function updateQuick() {
  if (!Q.root || Q.root.hidden) return;
  const t = S.tokens.get(S.sel);
  const p = S.paper;
  const pos = p?.positions.find((x) => x.mint === S.sel);
  Q.sym.textContent = t ? t.symbol || short(t.mint) : 'No token';
  Q.px.textContent = t ? fmtMc(t.mcap) : '';
  Q.bal.textContent = p ? fmtSol(p.balance, 3) + ' SOL' : '';
  if (pos) {
    Q.pos_.textContent = `${fmtSol(pos.value ?? pos.costSol, 3)} SOL · ${pos.pnlPct == null ? '' : sgn(pos.pnlPct, 1) + '%'}`;
    Q.pos_.className = 'qbal ' + (pos.pnlPct == null ? '' : pos.pnlPct >= 0 ? 'up' : 'dn');
  } else { Q.pos_.textContent = 'no position'; Q.pos_.className = 'qbal'; }
  const L = p?.limits;
  Q.fees.textContent = L ? `${L.priorityFeeSol} SOL fee · ${(L.slippageBps / 100).toFixed(1)}% slip` : '';
  let why = '';
  if (!t) why = 'Pick a token to trade.';
  else if (t.complete) why = 'Graduated: the curve is closed.';
  else if (p && !p.enabled) why = 'Kill switch is on. Buys are blocked, sells still work.';
  const noBuy = Boolean(why) || Q.busy;
  Q.buyGrid.querySelectorAll('button').forEach((b) => { b.disabled = noBuy; });
  Q.sellGrid.querySelectorAll('button').forEach((b) => { b.disabled = !pos || Q.busy; });
  Q.note.textContent = why;
  Q.note.hidden = !why;
}
async function quickTrade(side, v) {
  const t = S.tokens.get(S.sel);
  if (!t || Q.busy) return;
  Q.busy = true; updateQuick();
  const sym = t.symbol || short(t.mint);
  try {
    if (side === 'buy') {
      const r = await post('/api/paper/buy', { mint: S.sel, sol: v, tp: S.tp || null, sl: S.sl || null });
      if (r.ok) { S.paper = r.paper; toast('Bought ' + sym, `${fmtSol(r.fill.spent, 3)} SOL for ${compact(r.fill.tokens)} tokens`, 'good'); } else toast('Buy blocked', r.error, 'bad');
    } else {
      const r = await post('/api/paper/sell', { mint: S.sel, pct: v });
      if (r.ok) { S.paper = r.paper; toast('Sold ' + sym, `${fmtSol(r.fill.proceeds, 3)} SOL, PnL ${sgn(r.fill.pnl, 3)}`, r.fill.pnl >= 0 ? 'good' : 'bad'); } else toast('Sell blocked', r.error, 'bad');
    }
  } catch { toast('Trade failed', 'Could not reach the server.', 'bad'); }
  Q.busy = false;
  onPaper();
}

function onPaper() {
  renderEquity();
  renderPositions();
  refreshTradeUI();
  if (S.detail) chart.setStyle({ entry: chartOpts().entry });
  if (S.side === 'sell') refreshQuote();
}

/* ------------------------------------------------------------------ risk card */
const R = {};
function buildRisk() {
  const card = $('#riskCard');
  const g = el('div', { class: 'gauge' });
  g.innerHTML = '<svg viewBox="0 0 120 70" aria-hidden="true"><defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" stop-color="#2bf0b5"/><stop offset=".55" stop-color="#ffc24b"/><stop offset="1" stop-color="#ff4d7e"/></linearGradient></defs><path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="rgba(160,150,255,.14)" stroke-width="10" stroke-linecap="round"/><path id="rarc" d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="url(#rg)" stroke-width="10" stroke-linecap="round" stroke-dasharray="0 157"/></svg>';
  R.arc = g.querySelector('#rarc');
  R.num = el('div', { class: 'big' }, '—');
  R.lvl = el('div', { class: 'lvl dim' }, 'No token selected');
  g.append(el('div', {}, R.num, R.lvl));
  R.flags = el('div', { class: 'flags' });
  R.btn = el('button', { class: 'ghost', onclick: verify }, 'Verify on-chain');
  R.note = el('div', { class: 'note' }, 'Heuristic screen from live trades. It cannot prove a token is safe.');
  card.replaceChildren(el('h3', {}, 'Risk check'), g, R.flags, R.btn, R.note);
}
function renderRisk(risk) {
  if (!risk) return;
  R.num.textContent = risk.score;
  const col = risk.level === 'HIGH' ? 'var(--sell)' : risk.level === 'MED' ? 'var(--amber)' : 'var(--buy)';
  R.num.style.color = col;
  R.lvl.style.color = col;
  R.lvl.className = 'lvl';
  R.lvl.textContent = { LOW: 'Low risk', MED: 'Medium risk', HIGH: 'High risk' }[risk.level] + (risk.verified ? ' · verified on-chain' : '');
  R.arc.setAttribute('stroke-dasharray', `${(157 * risk.score) / 100} 157`);
  R.flags.replaceChildren(...risk.flags.map((f) => el('div', { class: 'flag ' + f.sev }, el('i'), el('div', {}, el('b', {}, f.label), el('span', {}, f.detail)))));
  R.btn.textContent = risk.verified ? 'Re-check on-chain' : 'Verify on-chain';
}
async function verify() {
  if (!S.sel) return;
  R.btn.disabled = true;
  R.btn.textContent = 'Checking…';
  const r = await post('/api/verify', { mint: S.sel }).catch(() => ({ ok: false, error: 'Request failed' }));
  R.btn.disabled = false;
  if (r.ok) { renderRisk(r.risk); toast('Verified on-chain', r.cached ? 'Using a check from the last 2 minutes.' : S.status?.mode === 'demo' ? 'Simulated result (demo mode).' : 'Costs about 4 RPC credits.', 'good'); }
  else { R.btn.textContent = 'Verify on-chain'; toast('Verification failed', r.error, 'bad'); }
}

/* ------------------------------------------------------------------ positions card */
const P = {};
function buildPositions() {
  const card = $('#posCard');
  P.seg = el('div', { class: 'seg' }, [['open', 'Open'], ['history', 'History']].map(([k, l]) => el('button', { class: S.posTab === k ? 'on' : '', onclick: (e) => { S.posTab = k; P.seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); renderPositions(); } }, l)));
  P.sum = el('div', { class: 'sumrow' });
  P.list = el('div');
  card.replaceChildren(el('h3', {}, 'Paper account', P.seg), P.sum, P.list);
}
function renderPositions() {
  const p = S.paper;
  if (!p) return;
  const m = (l, v, cls = '') => el('div', { class: 'metric' }, el('span', {}, l), el('b', { class: cls }, v));
  const closed = p.wins + p.losses;
  P.sum.replaceChildren(m('Balance', fmtSol(p.balance, 3) + ' SOL'), m('Realized', sgn(p.realized, 3), p.realized >= 0 ? 'up' : 'dn'), m('Win rate', closed ? pct(p.wins / closed, 0) + ` (${closed})` : '—'));
  if (S.posTab === 'open') {
    if (!p.positions.length) { P.list.replaceChildren(el('div', { class: 'empty' }, 'No open positions. Buy from the trade panel or hover a token in the list.')); return; }
    P.list.replaceChildren(...p.positions.map((x) => el('div', { class: 'pos', onclick: () => select(x.mint) },
      el('div', {}, el('span', { class: 's' }, x.symbol || short(x.mint)), el('div', { class: 'sm' }, `${fmtSol(x.costSol, 3)} in · worth ${x.value == null ? 'n/a' : fmtSol(x.value, 3)} SOL${x.tp ? ' · TP ' + x.tp + '%' : ''}${x.sl ? ' · SL ' + x.sl + '%' : ''}${x.complete ? ' · graduated' : ''}`)),
      el('div', { class: 'pnl ' + (x.pnlPct == null ? '' : x.pnlPct >= 0 ? 'up' : 'dn') }, x.pnlPct == null ? 'no price' : sgn(x.pnlPct, 1) + '%', el('div', { class: 'sm' }, x.pnlSol == null ? '' : sgn(x.pnlSol, 3) + ' SOL')),
      el('div', { class: 'acts' }, [50, 100].map((v) => el('button', { class: 'mini', onclick: async (e) => { e.stopPropagation(); const r = await post('/api/paper/sell', { mint: x.mint, pct: v }); if (r.ok) { S.paper = r.paper; toast('Sold ' + (x.symbol || short(x.mint)), `PnL ${sgn(r.fill.pnl, 3)} SOL`, r.fill.pnl >= 0 ? 'good' : 'bad'); onPaper(); } else toast('Sell blocked', r.error, 'bad'); } }, `Sell ${v}%`))))));
  } else {
    if (!p.history.length) { P.list.replaceChildren(el('div', { class: 'empty' }, 'Fills appear here.')); return; }
    P.list.replaceChildren(...p.history.slice(0, 40).map((h) => el('div', { class: 'pos', style: 'cursor:default' },
      el('div', {}, el('span', { class: 'sidepill ' + (h.side === 'buy' ? 'b' : 's') }, h.side), ' ', h.symbol || short(h.mint), el('div', { class: 'sm' }, `${clock(h.t)} · ${fmtSol(h.sol, 3)} SOL${h.reason !== 'manual' ? ' · ' + (h.reason === 'tp' ? 'take profit' : 'stop loss') : ''}`)),
      el('div', { class: 'pnl ' + (h.pnl == null ? '' : h.pnl >= 0 ? 'up' : 'dn') }, h.pnl == null ? '' : sgn(h.pnl, 3)))));
  }
}

/* ------------------------------------------------------------------ SSE */
function onInit(d) {
  S.cid = d.cid;
  S.viewOnly = Boolean(d.viewOnly);
  document.body.classList.toggle('viewonly', S.viewOnly);
  S.tokens = new Map(d.tokens.map((t) => [t.mint, t]));
  S.paper = d.paper;
  S.watch = d.watch;
  S.limits = d.config;
  if (d.solUsd) S.solUsd = d.solUsd;
  onStatus(d.status);
  renderEquity();
  renderPositions();
  renderBoard(true);
  refreshTradeUI();
  if (!S.sel) {
    // Deep link (#<mint>) or, failing that, open the busiest token that is still on the curve.
    const h = decodeURIComponent(location.hash.slice(1));
    const best = [...S.tokens.values()].filter((t) => !t.complete && t.price > 0).sort((a, b) => b.v5 - a.v5)[0];
    S.sel = S.tokens.has(h) ? h : best?.mint || null;
    if (S.tokens.has(h) && S.view !== 'trade') setView('trade'); // a shared link opens straight on the chart
  }
  if (S.sel) select(S.sel); // also re-registers the selection after a reconnect
}
function onUpd(d) {
  if (d.solUsd && d.solUsd !== S.solUsd) { S.solUsd = d.solUsd; unitChanged(); }
  for (const t of d.tokens) {
    S.tokens.set(t.mint, t);
    const r = S.rows.get(t.mint);
    if (r) updateRow(r, t);
    for (const ref of Object.values(laneRefs)) { const lr = ref.rows.get(t.mint); if (lr) updateCard(lr, t); }
    if (t.mint === S.sel) { updateHead(t); refreshTradeUI(); }
  }
  for (const m of d.evicted) if (m !== S.sel) S.tokens.delete(m);
  for (const a of d.alerts) {
    S.alerts.unshift(a);
    if (S.alerts.length > 200) S.alerts.pop();
    if (S.dock !== 'alerts') S.unread++;
    toast(`${a.label} ${a.side === 'buy' ? 'bought' : 'sold'} ${a.symbol || short(a.mint)}`, `${a.sol.toFixed(2)} SOL at ${fmtMc(a.mc)} cap`, a.side === 'buy' ? 'good' : 'bad', () => select(a.mint));
  }
  if (d.alerts.length) { updateDockTabs(); renderAlerts(); }
  for (const a of d.autos) toast((a.reason === 'tp' ? 'Take profit hit: ' : 'Stop loss hit: ') + (a.symbol || short(a.mint)), `Closed with ${sgn(a.pnl, 3)} SOL`, a.pnl >= 0 ? 'good' : 'bad');
  if (d.paper) { S.paper = d.paper; onPaper(); }
  const s = d.sel;
  if (s && s.mint === S.sel && S.detail) {
    for (const t of s.trades) {
      if (t.seq <= S.lastSeq) continue;
      S.lastSeq = t.seq;
      S.trades.unshift(t);
      if (S.dock === 'trades' && dockRefs.tbody) { dockRefs.tbody.prepend(tradeRow(t, true)); while (dockRefs.tbody.children.length > 60) dockRefs.tbody.lastChild.remove(); }
    }
    if (S.trades.length > 120) S.trades.length = 120;
    for (const c of s.candles[S.interval] || []) chart.upsert(c);
    if (s.risk) { renderRisk(s.risk); S.detail.risk = s.risk; }
    if (s.holders) { S.detail.holders = s.holders; renderHolders(s.holders); }
  }
}
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => onInit(JSON.parse(e.data)));
  es.addEventListener('upd', (e) => onUpd(JSON.parse(e.data)));
  es.addEventListener('status', (e) => onStatus(JSON.parse(e.data)));
  es.onerror = () => { const p = $('#modepill'); p.className = 'pill err'; p.textContent = 'server offline'; };
}

/* ------------------------------------------------------------------ boot */
buildTop();
// TradingView Lightweight Charts when the npm package is installed; otherwise the built-in canvas chart.
const loadLW = () => new Promise((resolve) => {
  if (lwAvailable()) return resolve(true);
  const s = document.createElement('script');
  s.src = '/vendor/lightweight-charts.js';
  s.onload = () => resolve(lwAvailable());
  s.onerror = () => resolve(false);
  document.head.append(s);
});
try { chart = (await loadLW()) ? new LWChart($('#chart')) : new Chart($('#chart')); } catch (err) { console.warn('Lightweight Charts failed, using the built-in chart.', err); chart = new Chart($('#chart')); }
buildBoardTabs();
buildLanes();
buildQuick();
$('#qtBtn').addEventListener('click', () => setQuick(Q.root.hidden));
document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
buildChartBar();
buildDockTabs();
buildTrade();
buildRisk();
buildPositions();
renderDock();
$('#hideHigh').checked = S.hideHigh;
$('#hideHigh').addEventListener('change', (e) => { S.hideHigh = e.target.checked; store.set('hideHigh', S.hideHigh); renderBoard(true); });
$('#search').addEventListener('input', (e) => { S.search = e.target.value; renderBoard(true); });
document.addEventListener('click', closePops);
window.addEventListener('keydown', (e) => {
  const box = S.view === 'dash' ? laneRefs.new.search : $('#search');
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); box.focus(); }
  else if (e.key === 'Escape') { closePops(); if (document.activeElement === box) box.blur(); else if (Q.root && !Q.root.hidden && !Q.edit) setQuick(false); }
});
setInterval(() => { if (S.tokens.size) renderBoard(false); }, 1000);
setInterval(pollTop, 5000);
setInterval(refreshQuote, 2000);
connect();
