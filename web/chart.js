// Dependency-free candlestick + volume chart on canvas.
// Wheel = zoom, drag = pan, double-click = jump to live edge.

const UP = '#2bf0b5';
const DOWN = '#ff4d7e';

function niceStep(range, target) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export class Chart {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.raw = [];
    this.step = 5000;
    this.mult = 1;
    this.fmt = (v) => String(v);
    this.entry = null;
    this.bars = 90;
    this.offset = 0;
    this.mouse = null;
    this.drag = null;
    this._dirty = true;
    this.series = [];

    new ResizeObserver(() => this._resize()).observe(canvas);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.bars = Math.min(500, Math.max(20, Math.round(this.bars * (e.deltaY > 0 ? 1.12 : 0.89))));
      this.invalidate();
    }, { passive: false });
    canvas.addEventListener('mousedown', (e) => { this.drag = { x: e.clientX, off: this.offset }; });
    window.addEventListener('mouseup', () => { this.drag = null; });
    window.addEventListener('mousemove', (e) => {
      const r = this.cv.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (this.drag && this.bw) {
        this.offset = Math.max(0, Math.min(Math.max(0, this.series.length - 10), Math.round(this.drag.off + (e.clientX - this.drag.x) / this.bw)));
        this.invalidate();
      }
      this.mouse = inside ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
      this.invalidate();
    });
    canvas.addEventListener('mouseleave', () => { this.mouse = null; this.invalidate(); });
    canvas.addEventListener('dblclick', () => { this.offset = 0; this.invalidate(); });
    const loop = () => {
      if (this._dirty) { this._dirty = false; this.draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() { this._dirty = true; }

  _resize() {
    const r = this.cv.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    this.cv.width = this.w * d;
    this.cv.height = this.h * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.invalidate();
  }

  setData(candles, step, { mult, fmt, entry }) {
    this.raw = candles.map((c) => ({ ...c }));
    this.step = step;
    this.mult = mult;
    this.fmt = fmt;
    this.entry = entry ?? null;
    this.offset = 0;
    this._build();
    // Young tokens should fill the chart instead of hugging the right edge.
    this.bars = Math.max(40, Math.min(120, this.series.length + 14));
    this.invalidate();
  }

  setStyle({ mult, fmt, entry }) {
    if (mult != null) this.mult = mult;
    if (fmt) this.fmt = fmt;
    if (entry !== undefined) this.entry = entry;
    this.invalidate();
  }

  upsert(c) {
    const last = this.raw[this.raw.length - 1];
    if (last && last.t === c.t) this.raw[this.raw.length - 1] = { ...c };
    else if (!last || c.t > last.t) this.raw.push({ ...c });
    if (this.raw.length > 1500) this.raw.shift();
    this._build();
  }

  clear() { this.raw = []; this.series = []; this.invalidate(); }

  // Fill short gaps with flat candles so the time axis stays honest.
  _build() {
    const out = [];
    const st = this.step;
    for (const c of this.raw) {
      const p = out[out.length - 1];
      if (p) {
        const gap = Math.round((c.t - p.t) / st) - 1;
        if (gap > 0 && gap <= 120) for (let i = 1; i <= gap; i++) out.push({ t: p.t + i * st, o: p.c, h: p.c, l: p.c, c: p.c, v: 0, n: 0, bv: 0 });
      }
      out.push(c);
    }
    const last = out[out.length - 1];
    if (last) {
      const nowB = Math.floor(Date.now() / st) * st;
      const gap = Math.round((nowB - last.t) / st);
      if (gap > 0 && gap <= 120) for (let i = 1; i <= gap; i++) out.push({ t: last.t + i * st, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, n: 0, bv: 0 });
    }
    this.series = out;
    this.invalidate();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    const padR = 74, padB = 24, padT = 12, padL = 8;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const volH = ph * 0.16;
    const priceH = ph - volH - 6;

    const end = this.series.length - this.offset;
    const start = Math.max(0, end - this.bars);
    const vis = this.series.slice(start, end);
    if (!vis.length) return;
    const bw = pw / this.bars;
    this.bw = bw;
    const m = this.mult;

    let lo = Infinity, hi = -Infinity, vmax = 0;
    for (const c of vis) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vmax = Math.max(vmax, c.v); }
    lo *= m; hi *= m;
    if (this.entry) { lo = Math.min(lo, this.entry); hi = Math.max(hi, this.entry); }
    if (hi - lo < hi * 0.002) { hi *= 1.01; lo *= 0.99; }
    const pad = (hi - lo) * 0.1;
    lo -= pad; hi += pad;
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * priceH;

    // grid + price axis
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const ts = niceStep(hi - lo, 6);
    ctx.strokeStyle = 'rgba(160,150,255,0.07)';
    ctx.fillStyle = '#6b6e8e';
    ctx.lineWidth = 1;
    for (let v = Math.ceil(lo / ts) * ts; v < hi; v += ts) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillText(this.fmt(v), w - padR + 8, yy);
    }
    // time axis
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const every = Math.max(1, Math.round(90 / bw));
    const xOf = (i) => padL + pw - (vis.length - i - 0.5) * bw;
    for (let i = 0; i < vis.length; i += every) {
      const d = new Date(vis[i].t);
      const lab = this.step >= 60000 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
      ctx.fillText(lab, xOf(i), h - padB + 6);
    }

    // volume
    const volTop = padT + priceH + 6;
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      if (!c.v) continue;
      const vh = Math.max(1, (c.v / (vmax || 1)) * volH);
      ctx.fillStyle = c.c >= c.o ? 'rgba(43,240,181,0.3)' : 'rgba(255,77,126,0.3)';
      ctx.fillRect(xOf(i) - bw * 0.35, volTop + volH - vh, Math.max(1, bw * 0.7), vh);
    }

    // candles
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      const x = xOf(i);
      const up = c.c >= c.o;
      const col = c.v === 0 && c.o === c.c ? '#4b4e6e' : up ? UP : DOWN;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(c.h * m)); ctx.lineTo(Math.round(x) + 0.5, y(c.l * m)); ctx.stroke();
      const y1 = y(c.o * m), y2 = y(c.c * m);
      ctx.fillRect(x - bw * 0.35, Math.min(y1, y2), Math.max(1, bw * 0.7), Math.max(1, Math.abs(y2 - y1)));
    }

    // entry line
    if (this.entry) {
      const yy = Math.round(y(this.entry)) + 0.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#ffc24b';
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffc24b';
      ctx.fillRect(w - padR, yy - 9, padR - 4, 18);
      ctx.fillStyle = '#241800';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('entry ' + this.fmt(this.entry), w - padR + 4, yy);
    }

    // last price
    const last = this.series[this.series.length - 1];
    const lp = last.c * m;
    const lc = last.c >= last.o ? UP : DOWN;
    const ly = Math.round(y(lp)) + 0.5;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = lc;
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(w - padR, ly); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = lc;
    ctx.fillRect(w - padR, ly - 9, padR - 4, 18);
    ctx.fillStyle = '#04120d';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(this.fmt(lp), w - padR + 4, ly);

    // crosshair + readout
    const mo = this.mouse;
    if (mo && mo.x > padL && mo.x < w - padR && mo.y > padT && mo.y < padT + priceH) {
      ctx.strokeStyle = 'rgba(200,195,255,0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mo.x + 0.5, padT); ctx.lineTo(mo.x + 0.5, h - padB); ctx.moveTo(padL, mo.y + 0.5); ctx.lineTo(w - padR, mo.y + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      const val = lo + (1 - (mo.y - padT) / priceH) * (hi - lo);
      ctx.fillStyle = '#2a2b55';
      ctx.fillRect(w - padR, mo.y - 9, padR - 4, 18);
      ctx.fillStyle = '#e9eaf6';
      ctx.fillText(this.fmt(val), w - padR + 4, mo.y);
      const idx = Math.round((mo.x - (padL + pw - vis.length * bw)) / bw - 0.5);
      const c = vis[idx];
      if (c) {
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = '#c3c5e0';
        ctx.fillText(`O ${this.fmt(c.o * m)}   H ${this.fmt(c.h * m)}   L ${this.fmt(c.l * m)}   C ${this.fmt(c.c * m)}   Vol ${c.v.toFixed(2)} SOL   ${c.n} txs`, padL + 6, padT + 2);
      }
    }
  }
}
