import test from 'node:test';
import assert from 'node:assert/strict';

// A recording stand-in for the Lightweight Charts library, so the adapter's calls can be checked without a browser.
function fakeLib() {
  const log = { candles: [], volume: [], updates: [], lines: [], removed: 0, range: null };
  const series = (kind) => ({
    setData: (d) => log[kind].push(d),
    update: (d) => log.updates.push([kind, d]),
    createPriceLine: (o) => { log.lines.push(o); return o; },
    removePriceLine: () => { log.removed++; },
  });
  return {
    log,
    lib: {
      CrosshairMode: { Normal: 0 }, LineStyle: { Dashed: 2 },
      createChart: () => ({
        addCandlestickSeries: () => series('candles'),
        addHistogramSeries: () => series('volume'),
        priceScale: () => ({ applyOptions() {} }),
        subscribeCrosshairMove() {},
        timeScale: () => ({ setVisibleLogicalRange: (r) => { log.range = r; }, scrollToRealTime() {} }),
      }),
    },
  };
}
const el = () => ({ style: {}, append() {}, after() {}, addEventListener() {}, set className(v) {}, textContent: '' });
globalThis.document = { createElement: el };

const { LWChart } = await import('../web/lwchart.js');
const T0 = 1_700_000_000_000;
const c = (i, o, h, l, cl, v = 1) => ({ t: T0 + i * 5000, o, h, l, c: cl, v, n: 1 });

test('maps candles to market cap and fills short gaps with flat bars', () => {
  const f = fakeLib();
  globalThis.LightweightCharts = f.lib;
  const ch = new LWChart(el());
  ch.setData([c(0, 1, 2, 1, 2), c(3, 2, 3, 2, 3)], 5000, { mult: 100, fmt: String, entry: null });
  const bars = f.log.candles[0];
  assert.equal(bars.length, 4); // 2 real + 2 flat fillers
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].high, 200);
  assert.equal(bars[1].open, 200); // filler carries the previous close
  assert.equal(bars[1].high, 200);
  assert.ok(bars.every((b, i) => i === 0 || b.time > bars[i - 1].time), 'times strictly ascend');
  assert.deepEqual(f.log.range, { from: 0, to: 10 });
});

test('upsert updates in place, appends, fills gaps and ignores stale candles', () => {
  const f = fakeLib();
  globalThis.LightweightCharts = f.lib;
  const ch = new LWChart(el());
  ch.setData([c(0, 1, 1, 1, 1)], 5000, { mult: 1, fmt: String });
  ch.upsert(c(0, 1, 2, 1, 2)); // same bucket
  ch.upsert(c(2, 2, 2, 2, 2)); // one empty bucket in between
  ch.upsert(c(-5, 1, 1, 1, 1)); // stale
  const candleUpdates = f.log.updates.filter(([k]) => k === 'candles');
  assert.equal(candleUpdates.length, 3); // same-bucket + filler + new
});

test('entry price line is replaced, not stacked', () => {
  const f = fakeLib();
  globalThis.LightweightCharts = f.lib;
  const ch = new LWChart(el());
  ch.setData([c(0, 1, 1, 1, 1)], 5000, { mult: 1, fmt: String, entry: 50 });
  ch.setStyle({ entry: 60 });
  ch.setStyle({ entry: null });
  assert.equal(f.log.lines.length, 2);
  assert.equal(f.log.removed, 2);
});

test('unit change rescales every bar', () => {
  const f = fakeLib();
  globalThis.LightweightCharts = f.lib;
  const ch = new LWChart(el());
  ch.setData([c(0, 1, 2, 1, 2)], 5000, { mult: 1, fmt: String });
  ch.setStyle({ mult: 150 });
  assert.equal(f.log.candles.at(-1)[0].high, 300);
});
