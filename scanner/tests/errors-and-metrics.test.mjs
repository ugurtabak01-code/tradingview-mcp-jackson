/**
 * errors.js + shadow-metrics.js — Patch 5 / D14 + D15.
 *
 * errors.js: machine-readable code'lu hata sinifi + factory'ler. Mesaj
 * formati KORUNUR (backward compat); code/context ek bilgi.
 * shadow-metrics.js: silent catch'leri counter'a aktarir; /api/health
 * uzerinden exposed olabilir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScanError, ScanErrorCode, isScanError,
  symbolSwitchFailed, barDataTimeout, chartSymbolMismatch,
  ohlcvContaminated, ohlcvStale, ohlcvDeviation,
} from '../lib/errors.js';

import {
  recordShadowDrop, getShadowMetrics, _resetShadowMetrics,
} from '../lib/shadow-metrics.js';

// ---------------------------------------------------------------------------
// errors.js
// ---------------------------------------------------------------------------

test('Patch 5: ScanError code, message, context', () => {
  const e = new ScanError('CHART_SYMBOL_MISMATCH', 'test', { symbol: 'BTCUSDT', timeframe: '240', extra: 1 });
  assert.equal(e.code, 'CHART_SYMBOL_MISMATCH');
  assert.equal(e.message, 'test');
  assert.equal(e.symbol, 'BTCUSDT');
  assert.equal(e.timeframe, '240');
  assert.equal(e.extra, 1);
  assert.equal(e.name, 'ScanError');
  assert.ok(e instanceof Error);
});

test('Patch 5: isScanError code-based ayirim', () => {
  assert.equal(isScanError(new ScanError('X', 'y')), true);
  assert.equal(isScanError(new Error('generic')), false);
  assert.equal(isScanError({ code: 'CDP_TIMEOUT' }), true); // bridge-timeout uyumlu
  assert.equal(isScanError(null), false);
});

test('Patch 5: ScanErrorCode taksonomi enum', () => {
  assert.equal(ScanErrorCode.SYMBOL_SWITCH_FAILED, 'SYMBOL_SWITCH_FAILED');
  assert.equal(ScanErrorCode.BAR_DATA_TIMEOUT, 'BAR_DATA_TIMEOUT');
  assert.equal(ScanErrorCode.CHART_SYMBOL_MISMATCH, 'CHART_SYMBOL_MISMATCH');
  assert.equal(ScanErrorCode.OHLCV_CONTAMINATED, 'OHLCV_CONTAMINATED');
  assert.equal(ScanErrorCode.OHLCV_STALE, 'OHLCV_STALE');
  assert.equal(ScanErrorCode.OHLCV_DEVIATION, 'OHLCV_DEVIATION');
  assert.equal(ScanErrorCode.CDP_TIMEOUT, 'CDP_TIMEOUT');
});

// Factory'ler — mesaj formati ve code dogrulama
test('Patch 5: symbolSwitchFailed factory', () => {
  const e = symbolSwitchFailed('BTC', 'BINANCE:BTCUSDT', 'baglanti yok');
  assert.equal(e.code, 'SYMBOL_SWITCH_FAILED');
  assert.ok(e.message.includes('BINANCE:BTCUSDT'));
  assert.ok(e.message.includes('baglanti yok'));
});

test('Patch 5: barDataTimeout factory — short/long ayrim', () => {
  const short = barDataTimeout('BTC', '240');
  const long = barDataTimeout('BTC', '1D', true);
  assert.equal(short.code, 'BAR_DATA_TIMEOUT');
  assert.equal(long.code, 'BAR_DATA_TIMEOUT');
  assert.ok(short.message.includes('TF240'));
  assert.ok(long.message.includes('(LTF)'));
  assert.equal(short.timeframe, '240');
  assert.equal(long.timeframe, '1D');
});

test('Patch 5: chartSymbolMismatch — pre/post + ltf varyantlari', () => {
  const pre = chartSymbolMismatch('BTC', '240', 'chart=ETH');
  const post = chartSymbolMismatch('BTC', '240', 'chart=ETH', { postRead: true });
  const long = chartSymbolMismatch('BTC', '1D', 'chart=ETH', { ltf: true });
  assert.equal(pre.code, 'CHART_SYMBOL_MISMATCH');
  assert.ok(pre.message.includes('GUVENILMEZ'));
  assert.ok(post.message.includes('CONTAMINATED'));
  assert.ok(long.message.includes('(LTF)'));
});

test('Patch 5: ohlcvContaminated — normal + retry', () => {
  const normal = ohlcvContaminated('BTC', '240', 'BTCUSDT', 'ETHUSDT');
  const retry = ohlcvContaminated('BTC', '240', 'BTCUSDT', 'ETHUSDT', { retry: true });
  assert.equal(normal.code, 'OHLCV_CONTAMINATED');
  assert.ok(normal.message.includes('CONTAMINATED'));
  assert.ok(retry.message.includes('retry'));
  assert.equal(normal.expected, 'BTCUSDT');
  assert.equal(normal.got, 'ETHUSDT');
});

test('Patch 5: ohlcvStale — normal + retry + withDeviation', () => {
  const s = ohlcvStale('BTC', '240', 600);
  const r = ohlcvStale('BTC', '240', 600, { retry: true });
  const d = ohlcvStale('BTC', '240', 600, { withDeviation: true, deviationPct: 8.5 });
  assert.equal(s.code, 'OHLCV_STALE');
  assert.ok(s.message.includes('600s'));
  assert.ok(r.message.includes('hala'));
  assert.ok(d.message.includes('8.5'));
  assert.equal(s.lastBarAge, 600);
});

test('Patch 5: ohlcvDeviation factory', () => {
  const e = ohlcvDeviation('BTC', '240', 50000, 51000, 1.96);
  assert.equal(e.code, 'OHLCV_DEVIATION');
  assert.ok(e.message.includes('50000'));
  assert.ok(e.message.includes('51000'));
  assert.ok(e.message.includes('1.96') || e.message.includes('2.0'));
  assert.equal(e.barClose, 50000);
  assert.equal(e.quotePrice, 51000);
});

// ---------------------------------------------------------------------------
// shadow-metrics.js
// ---------------------------------------------------------------------------

test('Patch 5: recordShadowDrop counter artirir', () => {
  _resetShadowMetrics();
  recordShadowDrop('regime');
  recordShadowDrop('regime');
  recordShadowDrop('fib');
  const m = getShadowMetrics();
  assert.equal(m.counters.regime, 2);
  assert.equal(m.counters.fib, 1);
  assert.equal(m.counters.snapshot, 0);
  assert.equal(m.totalDrops, 3);
});

test('Patch 5: getShadowMetrics firstSeen/lastSeen timestamp', async () => {
  _resetShadowMetrics();
  const before = Date.now();
  recordShadowDrop('regime');
  await new Promise(r => setTimeout(r, 5));
  recordShadowDrop('regime');
  const m = getShadowMetrics();
  assert.ok(m.firstSeen.regime >= before);
  assert.ok(m.lastSeen.regime >= m.firstSeen.regime);
});

test('Patch 5: bilinmeyen kategori sessizce ignore', () => {
  _resetShadowMetrics();
  recordShadowDrop('NONEXISTENT_CATEGORY');
  const m = getShadowMetrics();
  assert.equal(m.totalDrops, 0); // typo guard yok ama silent
});

test('Patch 5: tum bilinen kategoriler hazir', () => {
  _resetShadowMetrics();
  const expected = ['regime', 'snapshot', 'fib', 'fundamentals', 'shadow_mtf', 'shadow_features', 'learning'];
  for (const cat of expected) recordShadowDrop(cat);
  const m = getShadowMetrics();
  for (const cat of expected) {
    assert.equal(m.counters[cat], 1, `kategori eksik: ${cat}`);
  }
  assert.equal(m.totalDrops, expected.length);
});

test('Patch 5: _resetShadowMetrics tum sayaclari sifirlar', () => {
  recordShadowDrop('regime');
  recordShadowDrop('fib');
  _resetShadowMetrics();
  const m = getShadowMetrics();
  assert.equal(m.totalDrops, 0);
  assert.deepEqual(m.firstSeen, {});
});
