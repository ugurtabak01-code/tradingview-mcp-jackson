// Trendline engine - ihlal/kirilim/pierce testleri (Commit 1).
// node:test ile cagri: `node --test scanner/lib/__tests__/trendline-engine.test.js`
//
// Test stratejisi: buildCandidate'i dogrudan caginyoruz (findSwingPoints
// asilmasin diye). Pivotlari ve bar dizisini manuel kuruyoruz.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../trendline-engine.js';

const { buildCandidate } = __test;

// Yardimcilar — basit bar/pivot olusturucular.
function makeBar(i, { open = 100, high = 100, low = 100, close = 100 } = {}) {
  return { index: i, time: 1700000000 + i * 3600, open, high, low, close };
}

// 4H ATR simulasyonu: ortalama TR ~1.0 olacak sekilde 14 bar ekle, sonra
// ana senaryo barlarini ekle. ATR=1.0 → thresholds: touch~0.35, interior~0.40,
// posterior~0.50, closeBreak~0.30 (fiyat ~100).
function buildBaseline(length = 30, basePrice = 100) {
  const bars = [];
  for (let i = 0; i < length; i++) {
    // Sıralı 1.0'lik wick'ler ATR'ı ~1.0 yapar.
    bars.push(makeBar(i, {
      open: basePrice, high: basePrice + 0.5, low: basePrice - 0.5, close: basePrice,
    }));
  }
  return bars;
}

function pivotFromBar(bars, index, side) {
  const b = bars[index];
  return { index, time: b.time, price: side === 'high' ? b.high : b.low };
}

// --- TEST 1: P1-P2 arasi wick > 0.40 ATR (falling_resistance) → null ---
test('falling_resistance: interior wick ihlali → aday reddedilir', () => {
  const bars = buildBaseline(30, 100);

  // P1 (anchor high): bar 5, high=110
  bars[5] = makeBar(5, { open: 109, high: 110, low: 108, close: 108.5 });
  // P2 (anchor high): bar 20, high=100 (cizgi 5→20 boyunca 110'dan 100'e dusuyor)
  bars[20] = makeBar(20, { open: 100.5, high: 100, low: 99, close: 99.5 });

  // Ihlal bari: bar 12. Cizgi @ bar 12 = 110 + (100-110)*(12-5)/(20-5) = 110 - 4.67 = 105.33
  // Wick high=108 → ihlal 2.67, threshold ~0.40 ATR = 0.40 → reddedilmeli.
  bars[12] = makeBar(12, { open: 107, high: 108, low: 106.5, close: 107 });

  // ATR'i kabul edilebilir tutmak icin son barlarin TR'leri 1.0 civarinda
  for (let i = 21; i < 30; i++) {
    bars[i] = makeBar(i, { open: 99, high: 99.5, low: 98.5, close: 99 });
  }

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 20, 'high');

  const result = buildCandidate({
    type: 'falling_resistance',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.equal(result, null, 'Interior ihlal olan cizgi reddedilmeli');
});

// --- TEST 2: P1-P2 arasi wick > 0.40 ATR (rising_support) → null ---
test('rising_support: interior wick ihlali → aday reddedilir', () => {
  const bars = buildBaseline(30, 100);

  // P1 (anchor low): bar 5, low=90
  bars[5] = makeBar(5, { open: 91, high: 92, low: 90, close: 91.5 });
  // P2 (anchor low): bar 20, low=100 (yukselen destek 90→100)
  bars[20] = makeBar(20, { open: 100.5, high: 101.5, low: 100, close: 101 });

  // Ihlal bari: bar 12. Cizgi @ 12 = 90 + (100-90)*(12-5)/(20-5) = 94.67
  // Low=92 → ihlal 2.67. Reddedilmeli.
  bars[12] = makeBar(12, { open: 93, high: 93.5, low: 92, close: 93 });

  for (let i = 21; i < 30; i++) {
    bars[i] = makeBar(i, { open: 101, high: 102, low: 100.5, close: 101 });
  }

  const a = pivotFromBar(bars, 5, 'low');
  const b = pivotFromBar(bars, 20, 'low');

  const result = buildCandidate({
    type: 'rising_support',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.equal(result, null, 'Interior ihlal olan destek cizgisi reddedilmeli');
});

// --- TEST 3: P2 sonrasi wick pierce (close temiz) → pierced=true ---
test('posterior wick pierce, close temiz → pierced=true, confidence azalir', () => {
  const bars = buildBaseline(30, 100);

  // Falling resistance: bar 5 high=110 → bar 18 high=104 (egim -6/13)
  bars[5]  = makeBar(5,  { open: 109, high: 110, low: 108, close: 109 });
  bars[18] = makeBar(18, { open: 104.5, high: 104, low: 103, close: 103.5 });

  // P2 sonrasi (bar 24) wick pierce: cizgi @24 = 110 + (104-110)*(24-5)/13 = 110 - 8.77 = 101.23
  // High=102 → wick pierce 0.77 > 0.50 ATR. Close=101 (cizginin altinda) → close break degil.
  bars[24] = makeBar(24, { open: 101, high: 102, low: 100.5, close: 101 });

  // Son bar: cizgi @29 = 110 + (104-110)*(29-5)/13 = 110 - 11.08 = 98.92
  // Close 98.5 (cizginin altinda) → broken=false
  bars[29] = makeBar(29, { open: 98.5, high: 99, low: 98, close: 98.5 });

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 18, 'high');

  const result = buildCandidate({
    type: 'falling_resistance',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.ok(result, 'Aday üretilmeli');
  assert.equal(result.pierced, true, 'pierced=true olmali');
  assert.ok(result.posteriorPierces.length >= 1, 'En az 1 pierce kaydedilmeli');
  assert.equal(result.broken, false, 'broken=false olmali (close temiz)');
  // Pierce penalty −0.25 düşmeli. Base 0.25, span/touch düşük → confidence düşük olur.
  assert.ok(result.confidence < 0.6, 'Pierce penalty confidence dusurdü');
});

// --- TEST 4: Son bar close > line + 0.30 ATR → broken=true, recentCloseBreak.ageBars=0 ---
test('son bar close ile kirildi → broken=true, recentCloseBreak.ageBars=0', () => {
  const bars = buildBaseline(30, 100);

  bars[5]  = makeBar(5,  { open: 109, high: 110, low: 108, close: 109 });
  bars[18] = makeBar(18, { open: 104.5, high: 104, low: 103, close: 103.5 });

  // Bar 19-28: cizginin altinda kal
  for (let i = 19; i < 29; i++) {
    bars[i] = makeBar(i, { open: 100, high: 100.5, low: 99.5, close: 100 });
  }

  // Son bar (29): cizgi @29 ≈ 98.92. Close=100 → close break 1.08 > 0.30 ATR.
  bars[29] = makeBar(29, { open: 99, high: 100.5, low: 98.5, close: 100 });

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 18, 'high');

  const result = buildCandidate({
    type: 'falling_resistance',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.ok(result, 'Aday üretilmeli');
  assert.equal(result.broken, true, 'broken=true olmali');
  assert.ok(result.recentCloseBreak, 'recentCloseBreak dolu olmali');
  assert.equal(result.recentCloseBreak.ageBars, 0, 'Son barda kirildi → ageBars=0');
});

// --- TEST 6: stale cizgi — P2 sonrasi cogu bar yanlis tarafta kapaniyor → null ---
// COST 1D vakasi: kisa tabanli falling_resistance ileriye uzatilinca fiyattan
// kopuyor, fiyat haftalarca cizginin ustunde kapaniyor. Posterior reddi calismali.
test('falling_resistance: posterior cogunluk yanlis tarafta kapaniyor → aday reddedilir', () => {
  const bars = buildBaseline(60, 100);

  // Falling resistance: bar 5 high=110 → bar 18 high=104 (asagi egim)
  bars[5]  = makeBar(5,  { open: 109, high: 110, low: 108, close: 109 });
  bars[18] = makeBar(18, { open: 104.5, high: 104, low: 103, close: 103.5 });

  // P2 sonrasi 19..59 (41 bar): fiyat yukselip cizginin ustunde kalsin.
  // Cizgi @i = 110 + (104-110)*(i-5)/13, i buyudukce dusuyor (i=59 → ~85).
  // Close=108 → tum bu barlar yanlis tarafta kapanir (ratio ~1.0).
  for (let i = 19; i < 60; i++) {
    bars[i] = makeBar(i, { open: 108, high: 109, low: 107, close: 108 });
  }

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 18, 'high');

  const result = buildCandidate({
    type: 'falling_resistance',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.equal(result, null, 'Posterior cogunluk yanlis tarafta → stale cizgi reddedilmeli');
});

// --- TEST 7: taze kirilim — sadece son birkac bar yanlis tarafta → KORUNUR ---
test('falling_resistance: taze kirilim (sadece son barlar) → aday korunur', () => {
  const bars = buildBaseline(60, 100);

  bars[5]  = makeBar(5,  { open: 109, high: 110, low: 108, close: 109 });
  bars[18] = makeBar(18, { open: 104.5, high: 104, low: 103, close: 103.5 });

  // Cizgi egimi: (104-110)/(18-5) = -0.4615/bar. Cizgi @i = 110 - 0.4615*(i-5).
  var lineAt = function(i) { return 110 + (104 - 110) * (i - 5) / (18 - 5); };
  // 19..56: fiyat cizgiyle birlikte INSIN, ~2 puan altinda kalsin (saygi).
  for (let i = 19; i < 57; i++) {
    var c = lineAt(i) - 2;
    bars[i] = makeBar(i, { open: c, high: c + 0.4, low: c - 0.4, close: c });
  }
  // 57..59: kir (son 3 bar cizginin ustunde) → ratio ~3/41 dusuk → korunmali
  for (let i = 57; i < 60; i++) {
    var cb = lineAt(i) + 2;
    bars[i] = makeBar(i, { open: cb, high: cb + 0.4, low: cb - 0.4, close: cb });
  }

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 18, 'high');

  const result = buildCandidate({
    type: 'falling_resistance',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.ok(result, 'Taze kirilim stale degil — aday korunmali');
});

// --- TEST 8: role='resistance' + yukselen swing high'lar → rising_resistance ---
// Yeni tip: yukselen direnc (yukselen kanal/wedge ust siniri) artik uretilmeli.
test('role=resistance + pozitif egim → rising_resistance uretilir (artik reddedilmez)', () => {
  const bars = buildBaseline(30, 100);
  // Swing high'lar YUKSELEN: bar5 high=105 → bar18 high=115. Cizgi baseline (100)
  // ustunde, ihlal yok.
  bars[5]  = makeBar(5,  { open: 104, high: 105, low: 103, close: 104 });
  bars[18] = makeBar(18, { open: 114, high: 115, low: 113, close: 114 });

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 18, 'high');

  const result = buildCandidate({
    role: 'resistance', a, b, pivots: [a, b], bars, atrValue: 1.0, minPivotGap: 8,
  });

  assert.ok(result, 'Yukselen direnc adayi uretilmeli');
  assert.equal(result.type, 'rising_resistance', 'Tip rising_resistance olmali');
  assert.equal(result.role, 'resistance', 'Rol resistance olmali');
  assert.ok(result.slope > 0, 'Egim pozitif olmali');
});

// --- TEST 9: role='support' + dusen swing low'lar → falling_support ---
test('role=support + negatif egim → falling_support uretilir (artik reddedilmez)', () => {
  const bars = buildBaseline(30, 100);
  // Swing low'lar DUSEN: bar5 low=95 → bar18 low=85. Cizgi baseline (100) altinda.
  bars[5]  = makeBar(5,  { open: 96, high: 97, low: 95, close: 96 });
  bars[18] = makeBar(18, { open: 86, high: 87, low: 85, close: 86 });

  const a = pivotFromBar(bars, 5, 'low');
  const b = pivotFromBar(bars, 18, 'low');

  const result = buildCandidate({
    role: 'support', a, b, pivots: [a, b], bars, atrValue: 1.0, minPivotGap: 8,
  });

  assert.ok(result, 'Dusen destek adayi uretilmeli');
  assert.equal(result.type, 'falling_support', 'Tip falling_support olmali');
  assert.equal(result.role, 'support', 'Rol support olmali');
  assert.ok(result.slope < 0, 'Egim negatif olmali');
});

// --- TEST 5: P2 sonrasi close break, sonra fiyat geri donmus → broken=false, recentCloseBreak korunur ---
test('gecmis close break + fiyat geri dondu → broken=false ama recentCloseBreak dolu', () => {
  const bars = buildBaseline(30, 100);

  bars[5]  = makeBar(5,  { open: 109, high: 110, low: 108, close: 109 });
  bars[18] = makeBar(18, { open: 104.5, high: 104, low: 103, close: 103.5 });

  // Bar 22: close break. Cizgi @22 = 110 + (104-110)*(22-5)/13 = 110 - 7.85 = 102.15
  // Close=103 → close break 0.85 > 0.30 ATR.
  bars[22] = makeBar(22, { open: 102.5, high: 103.2, low: 102, close: 103 });

  // Bar 23-29: cizgiye geri don, altinda kal
  for (let i = 23; i < 30; i++) {
    bars[i] = makeBar(i, { open: 99, high: 99.5, low: 98.5, close: 99 });
  }
  // Cizgi @29 ≈ 98.92 → close 99 farki 0.08 → closeBreak esiginin altinda → broken=false

  const a = pivotFromBar(bars, 5, 'high');
  const b = pivotFromBar(bars, 18, 'high');

  const result = buildCandidate({
    type: 'falling_resistance',
    a, b,
    pivots: [a, b],
    bars,
    atrValue: 1.0,
    minPivotGap: 8,
  });

  assert.ok(result, 'Aday üretilmeli');
  assert.equal(result.broken, false, 'Son bar close break degil → broken=false');
  assert.ok(result.recentCloseBreak, 'Gecmis close break recentCloseBreak\'te tutulmali');
  assert.equal(result.recentCloseBreak.index, 22, 'Kirilim bari index=22');
  assert.equal(result.recentCloseBreak.ageBars, 29 - 22, 'ageBars = lastIndex - breakIndex');
  assert.equal(result.recentCloseBreak.direction, 'up', 'Falling resistance kirilimi yukari');
});
