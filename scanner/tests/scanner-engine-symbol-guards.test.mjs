/**
 * scanner-engine.js — symbol guard regression tests.
 *
 * 2026-05-23 bug (kontaminasyon): collectShortTermData/collectLongTermData
 * `if (preBare && preBare !== bareExpected)` guard'i kullaniyordu. Bridge
 * `getCurrentBareSymbol()` null donerse (CDP donmus / chart state okunamadi)
 * guard ATLANIYOR ve onceki sembolden gelen barlarla sinyal uretilebiliyordu.
 *
 * Fix: koşul `assertBareSymbolMatch(actual, expected)` helper'ina cikarildi;
 * actual null/undefined/'' → ok=false (fail-closed).
 *
 * Bug A2 (deviation retry mutation): retry sonrasi sadece `bars` ve
 * `total_bars` mutate ediliyordu; `stale`, `lastBarAge`, `lastBarTimestamp`
 * orijinal degerinde kaliyordu — downstream learning/grader yanilirdi.
 *
 * Fix: `mergeDeviationRetry(orig, retry)` immutable spread ile tam swap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertBareSymbolMatch,
  mergeDeviationRetry,
} from '../lib/scanner-engine.js';

// ---------------------------------------------------------------------------
// assertBareSymbolMatch
// ---------------------------------------------------------------------------

test('assertBareSymbolMatch: exact uppercase match', () => {
  const r = assertBareSymbolMatch('BTCUSDT', 'BTCUSDT');
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('assertBareSymbolMatch: case-insensitive (helper uppercases)', () => {
  const r = assertBareSymbolMatch('btcusdt', 'BTCUSDT');
  assert.equal(r.ok, true);
});

test('assertBareSymbolMatch: BA vs BABA — eski .includes() bug regression', () => {
  // Eski kod `currentSym.includes(bareSymbol)` kullaniyordu → "BA"
  // "BABA".includes("BA") === true ile gecip yanlis trend okuyordu.
  const r = assertBareSymbolMatch('BABA', 'BA');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('uyumsuz'));
});

test('assertBareSymbolMatch: BTC vs BTCUSDT (substring tuzagi)', () => {
  const r = assertBareSymbolMatch('BTCUSDT', 'BTC');
  assert.equal(r.ok, false);
});

test('assertBareSymbolMatch: actual null → fail-closed (2026-05-23 bug)', () => {
  // Bridge getCurrentBareSymbol() null donerse (CDP donmus) eski guard
  // `if (preBare && ...)` ATLIYORDU. Yeni helper null'i fail kabul eder.
  const r = assertBareSymbolMatch(null, 'BTCUSDT');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('okunamadi') || r.reason.includes('null'));
});

test('assertBareSymbolMatch: actual undefined → fail-closed', () => {
  const r = assertBareSymbolMatch(undefined, 'BTCUSDT');
  assert.equal(r.ok, false);
});

test('assertBareSymbolMatch: actual empty string → fail-closed', () => {
  const r = assertBareSymbolMatch('', 'BTCUSDT');
  assert.equal(r.ok, false);
});

test('assertBareSymbolMatch: expected null → fail (defensive)', () => {
  const r = assertBareSymbolMatch('BTCUSDT', null);
  assert.equal(r.ok, false);
});

test('assertBareSymbolMatch: ETHUSDC vs BTCUSDT (kontaminasyon senaryosu)', () => {
  // 2026-05-23 fatal: chart BTC'de iken yeni sembol ETHUSDC istendi, bars
  // hala BTC'nin (chart.symbol() yeni adi dondu ama mainSeries.bars() bayatti).
  // Bu durumda postBare === 'BTCUSDT' (chart sembolu bizim icinde olmamali)
  // ya da ETHUSDC bekleniyorken BTCUSDT okundu — abort sart.
  const r = assertBareSymbolMatch('BTCUSDT', 'ETHUSDC');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('BTCUSDT') && r.reason.includes('ETHUSDC'));
});

// ---------------------------------------------------------------------------
// mergeDeviationRetry
// ---------------------------------------------------------------------------

test('mergeDeviationRetry: retry tum alanlari uzerine yazar', () => {
  // Orjinal stale ve eski lastBarAge ile geldi
  const orig = {
    bars: [{ close: 100 }],
    total_bars: 100,
    stale: true,
    lastBarAge: 9999,
    lastBarTimestamp: 1000,
    symbolMismatch: false,
  };
  // Retry taze
  const retry = {
    bars: [{ close: 110 }],
    total_bars: 100,
    stale: false,
    lastBarAge: 5,
    lastBarTimestamp: 2000,
  };
  const merged = mergeDeviationRetry(orig, retry);

  // bars yeni
  assert.equal(merged.bars[0].close, 110);
  // stale alani guncellendi (eski mutation davranisi bunu kaciriyordu — bug A2)
  assert.equal(merged.stale, false);
  assert.equal(merged.lastBarAge, 5);
  assert.equal(merged.lastBarTimestamp, 2000);
  // orig'de olup retry'de olmayan alan korunur
  assert.equal(merged.symbolMismatch, false);
});

test('mergeDeviationRetry: orijinali mutate ETMEZ', () => {
  const orig = {
    bars: [{ close: 100 }],
    stale: true,
    lastBarAge: 9999,
  };
  const retry = {
    bars: [{ close: 110 }],
    stale: false,
    lastBarAge: 5,
  };
  mergeDeviationRetry(orig, retry);
  // Orjinal degismedi
  assert.equal(orig.bars[0].close, 100);
  assert.equal(orig.stale, true);
  assert.equal(orig.lastBarAge, 9999);
});

test('mergeDeviationRetry: retry null/bars yoksa orijinali doner', () => {
  const orig = { bars: [{ close: 100 }], stale: false };
  assert.equal(mergeDeviationRetry(orig, null), orig);
  assert.equal(mergeDeviationRetry(orig, {}), orig);
  assert.equal(mergeDeviationRetry(orig, { bars: [] }), orig);
});

test('mergeDeviationRetry: orig null + valid retry → retry alanlarini doner', () => {
  const retry = { bars: [{ close: 110 }], stale: false, lastBarAge: 5 };
  const merged = mergeDeviationRetry(null, retry);
  assert.equal(merged.bars[0].close, 110);
  assert.equal(merged.stale, false);
});
