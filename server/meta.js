import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

// Token metadata URIs are attacker-controlled. To avoid leaking your IP to random servers (or
// being pointed at localhost / your LAN), only IPFS content ids are ever fetched, and only
// through fixed public gateways. Anything else is ignored.

const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
const CID_RE = /\/ipfs\/([a-zA-Z0-9]{46,100})(?:[/?#]|$)/;
const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const cidFrom = (url) => CID_RE.exec(String(url || ''))?.[1] ?? null;

async function fetchLimited(url, { timeout = 6000, maxBytes = 200_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error('http ' + res.status);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks), type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
}

async function viaGateways(cid, opts) {
  let last;
  for (const g of GATEWAYS) {
    try {
      return await fetchLimited(g + cid, opts);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const clean = (s, max) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '';
const link = (s) => (typeof s === 'string' && /^https:\/\/[^\s]{3,200}$/.test(s.trim()) ? s.trim() : null);

const cache = new Map();
const inflight = new Map();

export async function getMeta(token, { demo = false } = {}) {
  const key = token.mint;
  if (cache.has(key)) return cache.get(key);
  if (!token.uri) return { description: '', imageCid: null, twitter: null, telegram: null, website: null };
  if (demo || token.uri.startsWith('demo://')) {
    // Placeholder links (clearly fake handles) so the layout can be seen in demo mode. Chosen per token, not random per request.
    const h = parseInt(crypto.createHash('sha1').update(key).digest('hex').slice(0, 8), 16);
    const slug = 'demo_' + String(token.symbol || 'token').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 9);
    const m = {
      description: `Simulated token ${token.symbol || ''}. This is demo data, not a real launch.`,
      imageCid: null,
      twitter: h % 5 < 3 ? `https://x.com/${slug}` : null,
      telegram: h % 5 === 1 || h % 5 === 4 ? `https://t.me/${slug}` : null,
      website: h % 4 === 0 ? `https://example.com/${slug}` : null,
    };
    cache.set(key, m);
    return m;
  }
  const cid = cidFrom(token.uri);
  if (!cid) return { description: '', imageCid: null, twitter: null, telegram: null, website: null, skipped: 'non-ipfs metadata is not fetched' };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const { buf } = await viaGateways(cid);
      const j = JSON.parse(buf.toString('utf8'));
      const m = {
        description: clean(j.description, 280),
        imageCid: cidFrom(j.image),
        twitter: link(j.twitter),
        telegram: link(j.telegram),
        website: link(j.website),
      };
      cache.set(key, m);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return m;
    } catch (e) {
      return { description: '', imageCid: null, twitter: null, telegram: null, website: null, error: 'metadata unavailable' };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const imgCache = new Map();
function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Proxy an IPFS image: size-capped, raster formats only (never SVG), type verified by magic bytes. */
export async function getImage(cid) {
  if (!/^[a-zA-Z0-9]{46,100}$/.test(cid)) throw new Error('bad cid');
  if (imgCache.has(cid)) return imgCache.get(cid);
  const { buf, type } = await viaGateways(cid, { timeout: 8000, maxBytes: 1_500_000 });
  const real = sniff(buf);
  if (!real || !IMG_TYPES.has(real) || (type && !type.startsWith('image/') && type !== 'application/octet-stream')) throw new Error('not a supported image');
  const out = { buf, type: real };
  imgCache.set(cid, out);
  if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value);
  return out;
}
