// Trendline plan candidates (Commit 2) — respect_pullback / breakout_retest
// gate kurallari.
//
// Strateji: buildTrendlineSignalContext'i dogrudan caginyoruz, sahte support/
// resistance objesi geciriyoruz. Boylece buildCandidate akisini test etmeden
// gate mantigini izole olarak dogruluyoruz.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrendlineSignalContext, __test } from '../trendline-engine.js';

const { getMaxBreakAgeBars } = __test;

// Sahte trendline objesi. canUseLineForPlan testi: confirmed=true, !tooSteep,
// confidence>=0.55.
function mockLine(overrides = {}) {
  return {
    type: 'rising_support',
    points: [
      { time: 1, price: 100, index: 0 },
      { time: 20, price: 110, index: 19 },
    ],
    currentValue: 110,
    lastClose: 111,
    distancePct: 0.9,         // fiyat cizginin %0.9 ustunde (pullback gate icin uygun)
    touches: [],
    touchCount: 3,
    confirmed: true,
    broken: false,
    recentCloseBreak: null,
    pierced: false,
    posteriorPierces: [],
    tooSteep: false,
    slope: 0.5,
    slopePctPerBar: 0.5,
    thresholds: {
      atr: 1.0, touch: 0.35, interiorHardReject: 0.40,
      posteriorPierce: 0.50, closeBreak: 0.30,
    },
    confidence: 0.75,
    ...overrides,
  };
}

// --- TEST 1: respect_pullback üretilmeli (temiz cizgi) ---
test('respect_pullback_long: temiz support + yakın fiyat → plan üretilmeli', () => {
  const support = mockLine({ type: 'rising_support' });
  const ctx = buildTrendlineSignalContext(
    { support, resistance: null, window: { timeframe: '1D' } },
    'long',
  );
  const plans = ctx.trendlinePlanCandidates;
  const respect = plans.find(p => p.planType === 'respect_pullback_long');
  assert.ok(respect, 'respect_pullback_long üretilmeli');
  assert.equal(respect.direction, 'long');
  assert.ok(respect.entry > respect.lineValue, 'Long entry cizginin ustunde olmali');
  assert.ok(respect.sl < respect.lineValue, 'Long SL cizginin altinda olmali');
  assert.ok(respect.riskPct > 0, 'Risk pozitif olmali');
});

// --- TEST 2: recentCloseBreak varken respect_pullback üretilmemeli ---
test('respect_pullback_long: recentCloseBreak varsa plan ÜRETİLMEMELİ', () => {
  const support = mockLine({
    type: 'rising_support',
    recentCloseBreak: {
      index: 25, time: 99, price: 108, lineValue: 109, distance: 1.0,
      ageBars: 3, direction: 'down',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support, resistance: null, window: { timeframe: '1D' } },
    'long',
  );
  const respect = ctx.trendlinePlanCandidates.find(p => p.planType === 'respect_pullback_long');
  assert.equal(respect, undefined, 'Cizgi gecmiste kirildi → respect uretmemeli');
});

// --- TEST 3: breakout_retest_long üretilmeli (yas tf sinirinda) ---
test('breakout_retest_long: ageBars <= maxBreakAge → plan üretilmeli', () => {
  // 1D icin maxBreakAge = 5
  const resistance = mockLine({
    type: 'falling_resistance',
    currentValue: 110,
    distancePct: 1.0,       // fiyat cizginin %1 ustunde (retest yakininda)
    slope: -0.5,
    recentCloseBreak: {
      index: 26, time: 99, price: 111, lineValue: 110, distance: 1.0,
      ageBars: 3, direction: 'up',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support: null, resistance, window: { timeframe: '1D' } },
    'long',
  );
  const retest = ctx.trendlinePlanCandidates.find(p => p.planType === 'breakout_retest_long');
  assert.ok(retest, 'breakout_retest_long üretilmeli (yas <= 5)');
  assert.equal(retest.breakAgeBars, 3);
  assert.ok(retest.entry > retest.lineValue, 'Long retest entry kirilan cizginin ustunde');
});

// --- TEST 4: breakout_retest_long yası asılınca üretilmemeli ---
test('breakout_retest_long: ageBars > maxBreakAge → plan ÜRETİLMEMELİ', () => {
  // 1D'de maxBreakAge=5, ageBars=8 → reddedilmeli
  const resistance = mockLine({
    type: 'falling_resistance',
    currentValue: 110,
    distancePct: 1.0,
    slope: -0.5,
    recentCloseBreak: {
      index: 21, time: 99, price: 111, lineValue: 110, distance: 1.0,
      ageBars: 8, direction: 'up',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support: null, resistance, window: { timeframe: '1D' } },
    'long',
  );
  const retest = ctx.trendlinePlanCandidates.find(p => p.planType === 'breakout_retest_long');
  assert.equal(retest, undefined, 'Eskimis kirilim → retest plani uretmemeli');
});

// --- TEST 5: getMaxBreakAgeBars timeframe ayrimi ---
test('getMaxBreakAgeBars timeframe basina dogru deger', () => {
  assert.equal(getMaxBreakAgeBars('240'), 6);
  assert.equal(getMaxBreakAgeBars('4H'),  6);
  assert.equal(getMaxBreakAgeBars('1D'),  5);
  assert.equal(getMaxBreakAgeBars('D'),   5);
  assert.equal(getMaxBreakAgeBars('1W'),  4);
  assert.equal(getMaxBreakAgeBars('W'),   4);
  assert.equal(getMaxBreakAgeBars(null),  5);   // default
  assert.equal(getMaxBreakAgeBars('60'),  5);   // unknown → default
});

// --- TEST 6: respect_pullback_short (mirror test) ---
test('respect_pullback_short: temiz resistance → plan üretilmeli', () => {
  const resistance = mockLine({
    type: 'falling_resistance',
    currentValue: 110,
    distancePct: -0.5,      // fiyat cizginin %0.5 altinda (short pullback gate)
    slope: -0.5,
  });
  const ctx = buildTrendlineSignalContext(
    { support: null, resistance, window: { timeframe: '1D' } },
    'short',
  );
  const respect = ctx.trendlinePlanCandidates.find(p => p.planType === 'respect_pullback_short');
  assert.ok(respect, 'respect_pullback_short üretilmeli');
  assert.ok(respect.entry < respect.lineValue, 'Short entry cizginin altinda');
  assert.ok(respect.sl > respect.lineValue, 'Short SL cizginin ustunde');
});

// --- TEST 7: confidence < 0.55 olunca plan üretilmemeli ---
test('canUseLineForPlan: dusuk confidence → plan üretilmemeli', () => {
  const support = mockLine({ confidence: 0.40 });
  const ctx = buildTrendlineSignalContext(
    { support, resistance: null, window: { timeframe: '1D' } },
    'long',
  );
  assert.equal(ctx.trendlinePlanCandidates.length, 0);
});

// =============================================================================
// Codex bug taramasi sonrasi eklenen regression testleri (2026-05-20).
// Bulgu 1 & 2: note/riskFlag uretimi recentCloseBreak'i hesaba katmali.
// =============================================================================

// --- REGRESSION 1: kirilan direnc icin "long_near_falling_resistance" risk
//     UYARISI uretilmemeli (ayni anda breakout_retest_long plani var) ---
test('Bulgu 1 — long: recentCloseBreak.up olan direnc → risk flag YAZILMAMALI', () => {
  const resistance = mockLine({
    type: 'falling_resistance',
    currentValue: 110,
    distancePct: 1.0,
    slope: -0.5,
    recentCloseBreak: {
      index: 26, time: 99, price: 111, lineValue: 110, distance: 1.0,
      ageBars: 3, direction: 'up',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support: null, resistance, window: { timeframe: '1D' } },
    'long',
  );
  assert.equal(
    ctx.riskFlags.includes('long_near_falling_resistance'), false,
    'Kirilan direnc icin long_near_falling_resistance riski YAZILMAMALI',
  );
  // Buna karsi breakout_retest_long plani uretilmis olmali (celiskinin onceki hali)
  assert.ok(
    ctx.trendlinePlanCandidates.find(p => p.planType === 'breakout_retest_long'),
    'Ayni durumda breakout_retest_long plani üretilmeli — celiski cozuldu',
  );
});

// --- REGRESSION 2: kirilan rising_support icin short tarafinda
//     "short_near_rising_support" risk yazilmamali ---
test('Bulgu 1 — short: recentCloseBreak.down olan destek → risk flag YAZILMAMALI', () => {
  const support = mockLine({
    type: 'rising_support',
    currentValue: 100,
    distancePct: -1.0,
    slope: 0.5,
    recentCloseBreak: {
      index: 26, time: 99, price: 98, lineValue: 100, distance: 1.0,
      ageBars: 3, direction: 'down',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support, resistance: null, window: { timeframe: '1D' } },
    'short',
  );
  assert.equal(
    ctx.riskFlags.includes('short_near_rising_support'), false,
    'Kirilan destek icin short_near_rising_support riski YAZILMAMALI',
  );
  assert.ok(
    ctx.trendlinePlanCandidates.find(p => p.planType === 'breakout_retest_short'),
    'Ayni durumda breakout_retest_short plani üretilmeli',
  );
});

// --- REGRESSION 3: rising_support gecmiste kirilmis (fiyat geri dondu) →
//     "long_near_confirmed_rising_support" pozitif notu YAZILMAMALI ---
test('Bulgu 2 — long: recentCloseBreak.down olan destek → pozitif note YAZILMAMALI', () => {
  const support = mockLine({
    type: 'rising_support',
    currentValue: 100,
    distancePct: 1.0,        // fiyat su an cizginin %1 ustunde (geri dondu)
    broken: false,            // su an kirik degil
    recentCloseBreak: {       // ama gecmiste kapanis ile kirilmis
      index: 25, time: 99, price: 98, lineValue: 100, distance: 1.0,
      ageBars: 4, direction: 'down',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support, resistance: null, window: { timeframe: '1D' } },
    'long',
  );
  assert.equal(
    ctx.notes.includes('long_near_confirmed_rising_support'), false,
    'Cizgi gecmiste kirildi → support "saygi goruyor" sayilamaz; note YAZILMAMALI',
  );
});

// --- REGRESSION 4: falling_resistance gecmiste kirilmis → short tarafinda
//     pozitif "short_near_confirmed_falling_resistance" notu YAZILMAMALI ---
test('Bulgu 2 — short: recentCloseBreak.up olan direnc → pozitif note YAZILMAMALI', () => {
  const resistance = mockLine({
    type: 'falling_resistance',
    currentValue: 110,
    distancePct: -1.0,       // fiyat su an cizginin %1 altinda (geri dondu)
    slope: -0.5,
    broken: false,
    recentCloseBreak: {
      index: 25, time: 99, price: 112, lineValue: 110, distance: 2.0,
      ageBars: 4, direction: 'up',
    },
  });
  const ctx = buildTrendlineSignalContext(
    { support: null, resistance, window: { timeframe: '1D' } },
    'short',
  );
  assert.equal(
    ctx.notes.includes('short_near_confirmed_falling_resistance'), false,
    'Direnc gecmiste kirildi → "saygi goruyor" sayilamaz; note YAZILMAMALI',
  );
});

// --- REGRESSION 5: trendlines.warnings → ctx.warnings'e tasiniyor (Bulgu 3) ---
test('Bulgu 3 — trendline motorundan gelen warnings ctx.warnings\'e tasinmali', () => {
  const ctx = buildTrendlineSignalContext(
    {
      support: null, resistance: null,
      window: { timeframe: '1D' },
      warnings: ['trendline_window_below_preferred_min:35<50'],
    },
    'long',
  );
  assert.ok(Array.isArray(ctx.warnings), 'ctx.warnings array olmali');
  assert.equal(ctx.warnings.length, 1);
  assert.equal(ctx.warnings[0], 'trendline_window_below_preferred_min:35<50');
});

// --- REGRESSION 6: pierced cizgi PLAN URETMEYE DEVAM ETMELI (Bulgu 5 karari) ---
test('Bulgu 5 — pierced cizgi plan üretmeli (anlik wick trendi bozmaz)', () => {
  const support = mockLine({
    type: 'rising_support',
    pierced: true,
    posteriorPierces: [{ index: 25, time: 99, price: 99, lineValue: 100, distance: 0.6 }],
    posteriorPierceCount: 1,
    confidence: 0.60,         // pierce penalty -0.25 sonrasi yine de >= 0.55
  });
  const ctx = buildTrendlineSignalContext(
    { support, resistance: null, window: { timeframe: '1D' } },
    'long',
  );
  assert.ok(
    ctx.trendlinePlanCandidates.find(p => p.planType === 'respect_pullback_long'),
    'Pierced cizgi plan uretmeye devam etmeli; pierce sadece UI badge ve confidence cezasi',
  );
  // Plan'da linePierced=true olarak isaretli olmali ki UI uyari verebilsin
  const plan = ctx.trendlinePlanCandidates.find(p => p.planType === 'respect_pullback_long');
  assert.equal(plan.linePierced, true, 'Plan icinde linePierced=true sinyali olmali');
});

// --- TEST 8: 4H timeframe icin maxBreakAge=6 sinirinda retest ---
test('breakout_retest_long 4H: ageBars=6 sinirda → uretilmeli, ageBars=7 → uretilmemeli', () => {
  const makeRes = (ageBars) => mockLine({
    type: 'falling_resistance',
    currentValue: 110,
    distancePct: 1.0,
    slope: -0.5,
    recentCloseBreak: {
      index: 30 - ageBars, time: 99, price: 111, lineValue: 110, distance: 1.0,
      ageBars, direction: 'up',
    },
  });

  const ok = buildTrendlineSignalContext(
    { support: null, resistance: makeRes(6), window: { timeframe: '240' } },
    'long',
  );
  assert.ok(
    ok.trendlinePlanCandidates.find(p => p.planType === 'breakout_retest_long'),
    '4H, ageBars=6 → plan üretilmeli',
  );

  const stale = buildTrendlineSignalContext(
    { support: null, resistance: makeRes(7), window: { timeframe: '240' } },
    'long',
  );
  assert.equal(
    stale.trendlinePlanCandidates.find(p => p.planType === 'breakout_retest_long'),
    undefined,
    '4H, ageBars=7 → plan üretilmemeli',
  );
});
