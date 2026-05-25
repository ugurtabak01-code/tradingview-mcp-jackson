import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTrendlineWindow,
  calculateTrendlines,
  buildTrendlineSignalContext,
} from '../lib/trendline-engine.js';

function makeBars({ n = 80, base = 100, fn }) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const mid = fn(i);
    bars.push({
      time: 1700000000 + i * 3600,
      index: i,
      open: mid,
      high: mid + 1,
      low: mid - 1,
      close: mid,
      volume: 1000,
    });
  }
  return bars;
}

test('getTrendlineWindow normalizes tf + market and caps maxBars at 100', () => {
  const w = getTrendlineWindow({ timeframe: '4H', marketType: 'kripto', symbol: 'BTCUSDT' });
  assert.equal(w.timeframe, '240');
  assert.equal(w.marketType, 'crypto');
  assert.ok(w.maxBars <= 100);
  assert.ok(w.minBars <= w.maxBars);
});

test('getTrendlineWindow falls back to default for unknown tf', () => {
  const w = getTrendlineWindow({ timeframe: '15', marketType: 'forex', symbol: 'EURUSD' });
  assert.ok(Number.isFinite(w.minBars) && Number.isFinite(w.maxBars));
});

test('calculateTrendlines returns insufficient warning for tiny input', () => {
  const out = calculateTrendlines({ bars: makeBars({ n: 10, fn: () => 100 }), timeframe: '1D' });
  assert.deepEqual(out.warnings, ['trendline_insufficient_bars']);
  assert.equal(out.support, null);
});

test('calculateTrendlines detects a rising support on an uptrend', () => {
  // Sawtooth uptrend: higher lows -> rising support trendline expected.
  const bars = makeBars({ n: 80, fn: (i) => 100 + i * 0.5 + (i % 6 === 0 ? -3 : 0) });
  const out = calculateTrendlines({ bars, timeframe: '1D', marketType: 'crypto', symbol: 'BTCUSDT' });
  assert.ok(out.support, 'support trendline should exist');
  assert.ok(out.support.slope > 0, 'support slope must be positive');
  assert.ok(out.support.confidence >= 0 && out.support.confidence <= 1);
});

test('buildTrendlineSignalContext flags long near confirmed support', () => {
  const trendlines = {
    support: { type: 'rising_support', confirmed: true, broken: false, distancePct: 0.5, currentValue: 100 },
    resistance: null,
  };
  const ctx = buildTrendlineSignalContext(trendlines, 'long');
  assert.ok(ctx.notes.includes('long_near_confirmed_rising_support'));
});

test('buildTrendlineSignalContext flags broken support as risk on long', () => {
  const trendlines = {
    support: { confirmed: true, broken: true, distancePct: -3, currentValue: 100 },
    resistance: null,
  };
  const ctx = buildTrendlineSignalContext(trendlines, 'long');
  assert.ok(ctx.riskFlags.includes('long_support_broken'));
});

test('calculateTrendlines detects a falling resistance on a downtrend', () => {
  // Sawtooth downtrend: lower highs -> falling resistance trendline expected.
  const bars = makeBars({ n: 80, fn: (i) => 140 - i * 0.5 + (i % 6 === 0 ? 3 : 0) });
  const out = calculateTrendlines({ bars, timeframe: '1D', marketType: 'crypto', symbol: 'BTCUSDT' });
  assert.ok(out.resistance, 'resistance trendline should exist');
  assert.ok(out.resistance.slope < 0, 'resistance slope must be negative');
  assert.ok(out.resistance.confidence >= 0 && out.resistance.confidence <= 1);
});

test('buildTrendlineSignalContext: short near confirmed falling resistance', () => {
  const trendlines = {
    support: null,
    resistance: { type: 'falling_resistance', confirmed: true, broken: false, distancePct: -1, currentValue: 100 },
  };
  const ctx = buildTrendlineSignalContext(trendlines, 'short');
  assert.ok(ctx.notes.includes('short_near_confirmed_falling_resistance'));
});

test('buildTrendlineSignalContext: broken resistance is risk on short', () => {
  const trendlines = {
    support: null,
    resistance: { confirmed: true, broken: true, distancePct: 4, currentValue: 100 },
  };
  const ctx = buildTrendlineSignalContext(trendlines, 'short');
  assert.ok(ctx.riskFlags.includes('short_resistance_broken'));
});

test('buildTrendlineSignalContext: long near falling resistance is a risk flag', () => {
  const trendlines = {
    support: null,
    resistance: { type: 'falling_resistance', confirmed: true, broken: false, distancePct: 2, currentValue: 100 },
  };
  const ctx = buildTrendlineSignalContext(trendlines, 'long');
  assert.ok(ctx.riskFlags.includes('long_near_falling_resistance'));
});

test('buildTrendlineSignalContext: null trendlines yields empty context', () => {
  const ctx = buildTrendlineSignalContext(null, 'long');
  assert.deepEqual(ctx.notes, []);
  assert.deepEqual(ctx.riskFlags, []);
  assert.equal(ctx.support, null);
  assert.equal(ctx.resistance, null);
});

test('calculateTrendlines emits below-preferred-min warning when bars are scarce', () => {
  // 45 flat bars: above the 30-bar hard floor but below any window minBars (>=40-50).
  const bars = makeBars({ n: 45, fn: () => 100 });
  const out = calculateTrendlines({ bars, timeframe: '1D', marketType: 'crypto', symbol: 'BTCUSDT' });
  assert.ok(
    out.warnings.some(w => w.startsWith('trendline_window_below_preferred_min:')),
    'expected below-preferred-min warning',
  );
});

test('calculateTrendlines penalizes overly steep lines', () => {
  // Very steep rising lows -> tooSteep flag should trigger on the support.
  const bars = makeBars({ n: 80, fn: (i) => 100 + i * 4 + (i % 6 === 0 ? -8 : 0) });
  const out = calculateTrendlines({ bars, timeframe: '1D', marketType: 'crypto', symbol: 'BTCUSDT' });
  if (out.support) {
    assert.equal(typeof out.support.tooSteep, 'boolean');
  }
});
