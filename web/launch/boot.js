// Launch page. Everything here is plain DOM code; the pump.fun transaction code lives in /launch/core.js (built with `npm run build`).
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const num = (v) => { const n = Number(String(v).trim().replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

const S = { cfg: null, net: 'devnet', provider: null, user: '', image: '', busy: false, core: null, bal: null };

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* handled below */ }
  if (!j) throw new Error('The server sent an unreadable answer (' + r.status + ').');
  if (j.ok === false) throw new Error(j.error || 'Request failed.');
  return j;
}
const rpc = async (method, params) => {
  const j = await fetch('/api/launch/rpc/' + S.net, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
};

function banner(text, bad) {
  const b = $('banner');
  b.hidden = !text;
  b.className = 'banner' + (bad ? ' bad' : '');
  b.textContent = text || '';
}
function showErr(t) { const e = $('err'); e.hidden = !t; e.textContent = t || ''; }

function setNet(n) {
  S.net = n;
  const b = $('net');
  b.textContent = n === 'mainnet' ? 'Mainnet · real SOL' : 'Devnet · practice';
  b.className = 'badge ' + (n === 'mainnet' ? 'main' : 'dev');
  $('drop').hidden = n !== 'devnet';
  $('confirmrow').hidden = n !== 'mainnet';
  $('confirm').value = '';
  const warn = [];
  if (n === 'mainnet' && S.cfg && !S.cfg.publicHttps) warn.push('Mainnet needs a public https address for the coin info. Deploy on Railway, or set LAUNCH_PUBLIC_URL.');
  banner(warn.join(' '), true);
  refreshBalance();
  refresh();
}

function sym() { return $('symbol').value.trim().replace(/^\$/, '').toUpperCase(); }

function refresh() {
  const buy = num($('buy').value);
  const max = S.cfg ? S.cfg.maxDevBuySol : 0;
  $('confirmtick').textContent = sym() ? '$' + sym() : '';
  const locked = S.cfg && S.cfg.oneOnly && S.cfg.history.some((h) => h.network === S.net);
  const needConfirm = S.net === 'mainnet' ? $('confirm').value.trim().replace(/^\$/, '').toUpperCase() === sym() && !!sym() : true;
  const mainnetOk = S.net !== 'mainnet' || (S.cfg && S.cfg.publicHttps);
  const ok = S.provider && S.user && !S.busy && $('name').value.trim() && sym() && S.image && buy > 0 && buy <= max && needConfirm && mainnetOk && !locked;
  $('go').disabled = !ok;
  $('go').textContent = S.net === 'mainnet' ? 'Launch on mainnet' : 'Launch on devnet';
  $('drop').disabled = !S.user || S.busy;
  $('feeCheck').disabled = !S.user || S.busy;
  $('feeClaim').disabled = !S.user || S.busy;
}

async function refreshBalance() {
  S.bal = null;
  $('bal').textContent = '';
  if (!S.user) return;
  try {
    const r = await rpc('getBalance', [S.user, { commitment: 'confirmed' }]);
    S.bal = r.value / 1e9;
    $('bal').textContent = S.bal.toFixed(3) + ' SOL';
  } catch { $('bal').textContent = 'balance unavailable'; }
}

function provider() {
  const p = (window.phantom && window.phantom.solana) || window.solana;
  return p && p.isPhantom ? p : null;
}

async function connect() {
  const p = provider();
  if (!p) return showErr('Phantom was not found. Install the Phantom extension, then reload this page.');
  showErr('');
  try {
    const r = await p.connect();
    S.provider = p;
    S.user = r.publicKey.toString();
    $('connect').textContent = S.user.slice(0, 4) + '…' + S.user.slice(-4);
    p.on && p.on('accountChanged', (pk) => { if (pk) { S.user = pk.toString(); $('connect').textContent = S.user.slice(0, 4) + '…' + S.user.slice(-4); refreshBalance(); } else disconnect(); });
    refreshBalance();
  } catch (e) { showErr(e && e.code === 4001 ? 'You declined the connection.' : 'Could not connect: ' + (e.message || e)); }
  refresh();
}
function disconnect() { S.provider = null; S.user = ''; $('connect').textContent = 'Connect Phantom'; refreshBalance(); refresh(); }

// ---------------------------------------------------------------- progress list
function step(label) {
  const list = $('steps');
  list.querySelector('.empty')?.remove();
  const li = el('li', 'run');
  li.append(el('span', 'ico'));
  const body = el('div');
  body.append(el('div', '', label));
  const det = el('div', 'det');
  body.append(det);
  li.append(body);
  list.append(li);
  li.scrollIntoView({ block: 'nearest' });
  return (state, detail, href) => {
    li.className = state || 'ok';
    det.textContent = detail || '';
    if (href && /^https:\/\/explorer\.solana\.com\//.test(href)) {
      det.append(' ');
      const a = el('a', '', 'Open');
      a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      det.append(a);
    }
  };
}

async function loadCore() {
  if (S.core) return S.core;
  try { S.core = await import('/launch/core.js'); } catch {
    throw new Error('The launch code is not built. Run "npm run build" (Railway does this on deploy), then reload.');
  }
  return S.core;
}

function renderHistory() {
  const ul = $('hist');
  ul.textContent = '';
  const rows = S.cfg ? S.cfg.history : [];
  if (!rows.length) { ul.append(el('li', 'empty', 'Nothing launched yet.')); return; }
  for (const h of rows) {
    const li = el('li');
    li.append(el('span'));
    const b = el('div');
    b.append(el('b', '', h.name + ' ($' + h.symbol + ')'), el('span', 'm', '  ' + h.network + ' · ' + h.devBuySol + ' SOL dev buy · ' + h.at.slice(0, 16).replace('T', ' ')));
    const links = el('div', 'det');
    const a = el('a', '', 'Explorer');
    a.href = 'https://explorer.solana.com/address/' + h.mint + (h.network === 'devnet' ? '?cluster=devnet' : '');
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    links.append(a);
    if (h.network === 'mainnet') {
      const p = el('a', '', 'pump.fun');
      p.href = 'https://pump.fun/coin/' + h.mint; p.target = '_blank'; p.rel = 'noopener noreferrer';
      links.append(' · ', p);
    }
    b.append(links);
    li.append(b);
    ul.append(li);
  }
}

// ---------------------------------------------------------------- launch
async function launch(ev) {
  ev.preventDefault();
  if ($('go').disabled) return;
  showErr('');
  S.busy = true; refresh();
  $('steps').textContent = '';
  $('result').hidden = true;
  const symbol = sym();
  const buy = num($('buy').value);
  try {
    const core = await loadCore();
    const prep = await (async () => {
      const done = step('Save coin info');
      try {
        const j = await api('/api/launch/prepare', {
          network: S.net, name: $('name').value, symbol, description: $('desc').value, website: $('website').value,
          twitter: $('twitter').value, telegram: $('telegram').value, image: S.image, devBuySol: buy,
        });
        done('ok', 'Hosted at ' + j.uri);
        return j;
      } catch (e) { done('err', e.message); throw e; }
    })();
    const res = await core.launchCoin({ network: S.net, wallet: S.provider, user: S.user, name: prep.meta.name, symbol: prep.meta.symbol, uri: prep.uri, devBuySol: buy }, step);
    try {
      const j = await api('/api/launch/record', { network: S.net, mint: res.mint, signature: res.signature, user: S.user, name: prep.meta.name, symbol: prep.meta.symbol, devBuySol: buy, id: prep.id });
      S.cfg.history = j.history; renderHistory();
    } catch (e) { step('Save to history')('warn', 'The coin is live, but the history entry failed: ' + e.message); }
    const box = $('result');
    box.hidden = false;
    box.textContent = '';
    box.append(el('b', '', 'Launched. '), 'Mint ' + res.mint + ' ');
    const a = el('a', '', S.net === 'mainnet' ? 'View on pump.fun' : 'View on Solana Explorer');
    a.href = S.net === 'mainnet' ? 'https://pump.fun/coin/' + res.mint : 'https://explorer.solana.com/address/' + res.mint + '?cluster=devnet';
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    box.append(a);
    refreshBalance();
  } catch (e) {
    showErr(e && e.code === 4001 ? 'You declined the request in your wallet. Nothing was launched.' : (e.message || String(e)));
  } finally { S.busy = false; refresh(); }
}

async function guarded(fn) {
  S.busy = true; refresh(); showErr('');
  try { await fn(); } catch (e) { showErr(e && e.code === 4001 ? 'You declined the request.' : (e.message || String(e))); } finally { S.busy = false; refresh(); }
}

async function init() {
  try { S.cfg = await api('/api/launch/config'); } catch (e) { banner('The launch tools are switched off on this server. Set LAUNCH_ENABLED=1 to turn them on.', true); $('go').disabled = true; return; }
  $('cap').textContent = '(max ' + S.cfg.maxDevBuySol + ')';
  renderHistory();
  setNet(S.cfg.defaultNetwork);
  if (!provider()) banner('Phantom was not detected in this browser. Install it to sign the launch.', false);

  $('connect').addEventListener('click', () => (S.user ? disconnect() : connect()));
  $('net').addEventListener('click', () => { if (!S.busy) setNet(S.net === 'devnet' ? 'mainnet' : 'devnet'); });
  for (const id of ['name', 'symbol', 'desc', 'buy', 'confirm', 'website', 'twitter', 'telegram']) $(id).addEventListener('input', refresh);
  $('image').addEventListener('change', () => {
    const f = $('image').files[0];
    S.image = '';
    $('preview').hidden = true;
    showErr('');
    if (f) {
      if (f.size > 1_500_000) showErr('That picture is over 1.5 MB. Use a smaller one.');
      else {
        const fr = new FileReader();
        fr.onload = () => { S.image = String(fr.result); $('preview').src = S.image; $('preview').hidden = false; refresh(); };
        fr.readAsDataURL(f);
      }
    }
    refresh();
  });
  $('form').addEventListener('submit', launch);
  $('drop').addEventListener('click', () => guarded(async () => {
    const done = step('Request 1 devnet SOL');
    try { const core = await loadCore(); await core.airdrop(S.user, 1); done('ok', 'Received'); refreshBalance(); } catch (e) { done('err', e.message); throw e; }
  }));
  $('feeCheck').addEventListener('click', () => guarded(async () => {
    const core = await loadCore();
    $('feeOut').textContent = (await core.creatorFees(S.net, S.user)).toFixed(6) + ' SOL waiting';
  }));
  $('feeClaim').addEventListener('click', () => guarded(async () => {
    const core = await loadCore();
    $('steps').textContent = '';
    await core.claimCreatorFees({ network: S.net, wallet: S.provider, user: S.user }, step);
    $('feeOut').textContent = 'Claimed';
    refreshBalance();
  }));
  refresh();
}
init();
