// Candlestick + volume chart on TradingView's open-source Lightweight Charts (v4 API).
// Same interface as chart.js so app.js can use either one:
//   setData(candles, step, { mult, fmt, entry }), setStyle({ mult, fmt, entry }), upsert(c), clear()
// Candles arrive as { t (ms), o, h, l, c, v, n } in price-per-token; `mult` turns them into market cap.

const UP = '#2bf0b5';
const DOWN = '#ff4d7e';
const FLAT = '#4b4e6e';
const TZ_SHIFT = () => new Date().getTimezoneOffset() * 60; // the library draws UTC; shift so the axis shows local time

export const lwAvailable = () => Boolean(globalThis.LightweightCharts);

export class LWChart {
  constructor(canvas) {
    const L = globalThis.LightweightCharts;
    this.L = L;
    this.mult = 1;
    this.fmt = (v) => String(v);
    this.entry = null;
    this.entryLine = null;
    this.step = 5000;
    this.raw = [];
    this.byTime = new Map();
    this.last = null;

    this.host = document.createElement('div');
    this.host.className = 'lwhost';
    this.legend = document.createElement('div');
    this.legend.className = 'lwlegend';
    canvas.after(this.host);
    this.host.append(this.legend);
    canvas.style.display = 'none';

    const grid = 'rgba(160,150,255,0.07)';
    const border = 'rgba(160,150,255,0.18)';
    this.chart = L.createChart(this.host, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8d90ad', fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: true, rightOffset: 4, barSpacing: 9 },
      crosshair: { mode: L.CrosshairMode.Normal, vertLine: { color: 'rgba(200,195,255,0.35)', labelBackgroundColor: '#2a2b55' }, horzLine: { color: 'rgba(200,195,255,0.35)', labelBackgroundColor: '#2a2b55' } },
      localization: { priceFormatter: (v) => this.fmt(v) },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
      priceFormat: { type: 'custom', formatter: (v) => this.fmt(v), minMove: 0.0000001 },
    });
    this.volume = this.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.chart.subscribeCrosshairMove((p) => this._legend(p));
    this.host.addEventListener('dblclick', () => this.chart.timeScale().scrollToRealTime());
  }

  _time(t) { return Math.floor(t / 1000) - TZ_SHIFT(); }

  _bar(c) {
    const m = this.mult;
    return { time: this._time(c.t), open: c.o * m, high: c.h * m, low: c.l * m, close: c.c * m };
  }

  _vol(c) {
    const flat = c.v === 0 && c.o === c.c;
    return { time: this._time(c.t), value: c.v, color: flat ? FLAT : c.c >= c.o ? 'rgba(43,240,181,0.35)' : 'rgba(255,77,126,0.35)' };
  }

  // Short gaps are filled with flat candles so quiet stretches still take up room on the time axis.
  _fill(prevT, prevC, nextT) {
    const out = [];
    const gap = Math.round((nextT - prevT) / this.step) - 1;
    if (gap > 0 && gap <= 120) for (let i = 1; i <= gap; i++) out.push({ t: prevT + i * this.step, o: prevC, h: prevC, l: prevC, c: prevC, v: 0, n: 0 });
    return out;
  }

  _build() {
    const out = [];
    for (const c of this.raw) {
      const p = out[out.length - 1];
      if (p) out.push(...this._fill(p.t, p.c, c.t));
      out.push(c);
    }
    return out;
  }

  _apply(keepRange) {
    const series = this._build();
    this.byTime = new Map(series.map((c) => [this._time(c.t), c]));
    this.candles.setData(series.map((c) => this._bar(c)));
    this.volume.setData(series.map((c) => this._vol(c)));
    const last = series[series.length - 1];
    this.last = last ? { t: last.t, c: last.c } : null;
    if (!keepRange) {
      const n = series.length;
      this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 6 });
    }
  }

  _drawEntry() {
    if (this.entryLine) { this.candles.removePriceLine(this.entryLine); this.entryLine = null; }
    if (this.entry) {
      this.entryLine = this.candles.createPriceLine({ price: this.entry, color: '#ffc24b', lineWidth: 1, lineStyle: this.L.LineStyle.Dashed, axisLabelVisible: true, title: 'entry' });
    }
  }

  setData(candles, step, { mult, fmt, entry }) {
    this.raw = candles.map((c) => ({ ...c }));
    this.step = step;
    this.mult = mult;
    this.fmt = fmt;
    this.entry = entry ?? null;
    this._apply(false);
    this._drawEntry();
  }

  setStyle({ mult, fmt, entry }) {
    const rescale = mult != null && mult !== this.mult;
    if (mult != null) this.mult = mult;
    if (fmt) this.fmt = fmt;
    if (rescale || fmt) this._apply(true);
    if (entry !== undefined) { this.entry = entry; this._drawEntry(); }
  }

  upsert(c) {
    const last = this.raw[this.raw.length - 1];
    if (last && c.t < last.t) return; // the library only accepts updates at or after the newest bar
    if (last && last.t === c.t) this.raw[this.raw.length - 1] = { ...c };
    else this.raw.push({ ...c });
    if (this.raw.length > 1500) this.raw.shift();
    if (this.last && c.t > this.last.t) {
      for (const f of this._fill(this.last.t, this.last.c, c.t)) this._push(f);
    }
    this._push(c);
  }

  _push(c) {
    this.byTime.set(this._time(c.t), c);
    this.candles.update(this._bar(c));
    this.volume.update(this._vol(c));
    this.last = { t: c.t, c: c.c };
  }

  clear() {
    this.raw = [];
    this.byTime = new Map();
    this.last = null;
    this.candles.setData([]);
    this.volume.setData([]);
  }

  _legend(p) {
    const c = p && p.time != null ? this.byTime.get(p.time) : null;
    if (!c) { this.legend.textContent = ''; return; }
    const m = this.mult;
    this.legend.textContent = `O ${this.fmt(c.o * m)}   H ${this.fmt(c.h * m)}   L ${this.fmt(c.l * m)}   C ${this.fmt(c.c * m)}   Vol ${c.v.toFixed(2)} SOL   ${c.n} txs`;
  }
}
