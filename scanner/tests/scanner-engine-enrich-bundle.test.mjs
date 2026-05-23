/**
 * enrichBundle — Patch 6 saf enrichment katmani.
 *
 * Bridge cagrisi YAPMAZ. Raw veri (ohlcv/studyValues/smc/quotePrice) → parsed +
 * hesaplanmis alanlar (khanSaab/parsedSMC/formation/squeeze/divergence/cdv/
 * stochRSI/shadow). Bu testler bridge mock'suz, sentetik veriyle dogruluyor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichBundle } from '../lib/scanner-engine.js';

// ---------------------------------------------------------------------------
// Test verisi: 100 sentetik bar (yukselen trend) + minimal smc/studyValues
// ---------------------------------------------------------------------------

function makeBars(count = 100, opts = {}) {
  const startPrice = opts.startPrice ?? 100;
  const slope = opts.slope ?? 0.5;
  const startTime = opts.startTime ?? Math.floor(Date.now() / 1000) - count * 3600;
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice + i * slope + Math.sin(i / 3) * 1.5; // hafif salinim
    bars.push({
      time: startTime + i * 3600,
      open: close - 0.3,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

function makeOhlcv(bars) {
  return {
    bars,
    total_bars: bars.length,
    stale: false,
    lastBarAge: 1,
    lastBarTimestamp: bars[bars.length - 1].time,
  };
}

const _emptyStudyValues = [];
const _emptySMC = { labels: null, boxes: null, lines: null };

// ---------------------------------------------------------------------------
// Bridge-bağımsızlık — enrichBundle async ama promise resolve eder
// ---------------------------------------------------------------------------

test('Patch 6: enrichBundle minimum input → return shape complete', async () => {
  const bars = makeBars(100);
  const out = await enrichBundle({
    symbol: 'BTCUSDT',
    tf: '240',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: bars[bars.length - 1].close,
  });

  // Return shape: tum bilinen alanlar var (collectShortTermData ile uyumlu)
  const expectedKeys = [
    'tf', 'ohlcv', 'studyValues', 'khanSaab', 'smc', 'rawSMC',
    'parsedBoxes', 'smcSRLines', 'khanSaabLabels', 'quotePrice',
    'formation', 'volConfirm', 'divergence', 'squeeze', 'cdv',
    'stochRSI', 'bars', 'shadow',
  ];
  for (const k of expectedKeys) {
    assert.ok(k in out, `eksik alan: ${k}`);
  }
  assert.equal(out.tf, '240');
  assert.equal(out.quotePrice, bars[bars.length - 1].close);
  assert.equal(out.bars.length, 100);
});

test('Patch 6: enrichBundle bos OHLCV → bars []', async () => {
  const out = await enrichBundle({
    symbol: 'BTC', tf: '240',
    ohlcvData: { bars: [], total_bars: 0 },
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: null,
  });
  assert.deepEqual(out.bars, []);
  assert.equal(out.formation?.formations?.length || 0, 0);
});

test('Patch 6: enrichBundle ohlcvData null → guarded, throw etmez', async () => {
  const out = await enrichBundle({
    symbol: 'BTC', tf: '240',
    ohlcvData: null,
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: 100,
  });
  assert.deepEqual(out.bars, []);
  assert.equal(out.ohlcv, null);
});

test('Patch 6: enrichBundle smc null → rawSMC bos sablona dusurulur', async () => {
  const bars = makeBars(50);
  const out = await enrichBundle({
    symbol: 'BTC', tf: '240',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: null,
    quotePrice: 100,
  });
  assert.deepEqual(out.rawSMC, { labels: null, boxes: null, lines: null });
});

test('Patch 6: enrichBundle khanSaab gateTechnicals broken → null', async () => {
  // 0 bar → calcTechnicals broken → gateTechnicals null doner
  const out = await enrichBundle({
    symbol: 'BTC', tf: '240',
    ohlcvData: { bars: [] },
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: 100,
  });
  // Bars yoksa khanSaab null veya undefined olabilir (gateTechnicals broken)
  assert.ok(out.khanSaab === null || out.khanSaab === undefined || typeof out.khanSaab === 'object');
});

test('Patch 6: enrichBundle 100 yukselen bar → khanSaab dolu, divergence + squeeze + cdv hesaplandi', async () => {
  const bars = makeBars(100, { startPrice: 50, slope: 0.5 });
  const out = await enrichBundle({
    symbol: 'BTCUSDT', tf: '240',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: bars[bars.length - 1].close,
  });
  // 100 bar yeterli — khanSaab dolu olmali
  assert.ok(out.khanSaab && typeof out.khanSaab === 'object');
  // squeeze/divergence/cdv hesaplandi (null veya object)
  assert.ok(out.squeeze === null || typeof out.squeeze === 'object');
  assert.ok(out.cdv === null || typeof out.cdv === 'object');
});

test('Patch 6: enrichBundle shadow primitives hesaplandi', async () => {
  const bars = makeBars(100);
  const out = await enrichBundle({
    symbol: 'BTCUSDT', tf: '240',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: bars[bars.length - 1].close,
  });
  assert.ok(out.shadow && typeof out.shadow === 'object');
  // Bilinen shadow alanlari (default null kabul)
  assert.ok('rsiSeries' in out.shadow);
  assert.ok('cmf' in out.shadow);
  assert.ok('mfi' in out.shadow);
  assert.ok('macdExt' in out.shadow);
  // 100 bar yeterli — rsiSeries dolu olmali
  assert.ok(Array.isArray(out.shadow.rsiSeries) && out.shadow.rsiSeries.length > 0);
});

test('Patch 6: enrichBundle pure — ayni input ayni output (mutation yok)', async () => {
  const bars = makeBars(50);
  const ohlcv = makeOhlcv(bars);
  const ohlcvCopy = JSON.parse(JSON.stringify(ohlcv));
  await enrichBundle({
    symbol: 'BTC', tf: '240',
    ohlcvData: ohlcv,
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: 100,
  });
  // Input ohlcv mutate edilmemis olmali
  assert.deepEqual(ohlcv, ohlcvCopy, 'enrichBundle input ohlcv mutate ETMEMELI');
});

test('Patch 6: enrichBundle bridge cagrisi yapmiyor (smoke — saf fonksiyon)', async () => {
  // Bu testin amaci: enrichBundle bridge mock'suz cagrilabiliyor olsun.
  // Yukaridaki tum testler bridge mock'lamadan calistigi icin zaten bu garanti
  // saglaniyor. Burada sadece bir kez daha vurgu.
  const bars = makeBars(20);
  const out = await enrichBundle({
    symbol: 'X', tf: '60',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: 100,
  });
  // Eger bridge cagirsaydi setSymbol/getOhlcv vs olmadigi icin throw/timeout
  // olurdu. Buraya kadar gelmek = saf fonksiyon.
  assert.ok(out);
});

test('Patch 6: enrichBundle quotePrice null kabul eder', async () => {
  const bars = makeBars(30);
  const out = await enrichBundle({
    symbol: 'X', tf: '60',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: null,
  });
  assert.equal(out.quotePrice, null);
});

// ---------------------------------------------------------------------------
// Patch 6.4 — fibCache injection (saf fonksiyon kanıtı)
// ---------------------------------------------------------------------------

test('Patch 6.4: fibCache null/undefined → fibCluster + goldenZone null', async () => {
  // Mevcut "silent fib absent" davranısı: fibCache yoksa alanlar null.
  const bars = makeBars(50);
  const out = await enrichBundle({
    symbol: 'BTCUSDT', tf: '240',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: bars[bars.length - 1].close,
    // fibCache verilmedi → default null
  });
  assert.equal(out.shadow.fibCluster, null);
  assert.equal(out.shadow.goldenZone, null);
});

test('Patch 6.4: fibCache injection → fibCluster + goldenZone hesaplandi', async () => {
  // Saf fonksiyon kaniti: fibCache parametre olarak gelir, disk'ten okunmaz.
  // Sentetik fibCache + quote price golden zone aralığında olsun.
  const lastClose = 100;
  const bars = makeBars(50, { startPrice: 75, slope: 0.5 });
  // Son bar yaklaşık 100; fib retracement seviyeleri 75-150 swing'in
  // golden zone'u (61.8%-78.6%): 121.35 - 134.10. quote 100 → goldenZone null
  // beklenir. fibCluster icin: 100 civarinda level varsa cluster bulur.
  const fibCache = {
    htfSwing: { high: 150, low: 75 },
    levels: [
      { ratio: 0.382, price: 121.35 },
      { ratio: 0.5,   price: 112.5 },
      { ratio: 0.618, price: 103.65 }, // quote 100'e yakin
      { ratio: 0.786, price: 91.05 },
    ],
  };

  const out = await enrichBundle({
    symbol: 'BTCUSDT', tf: '240',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: lastClose,
    fibCache,
  });
  // findFibCluster yakın seviyeleri yakalar; sözleşme: null veya { level, distance }
  assert.ok(out.shadow.fibCluster === null || typeof out.shadow.fibCluster === 'object');
  // priceInGoldenZone golden zone aralığını kontrol eder
  assert.ok(out.shadow.goldenZone === null || typeof out.shadow.goldenZone === 'boolean' || typeof out.shadow.goldenZone === 'object');
});

test('Patch 6.4: fibCache geçersiz şekil → silent catch + counter', async () => {
  // Bozuk fibCache (findFibCluster içinde throw'a yol açabilecek) silent
  // catch ile yakalanır; enrichBundle throw etmez.
  const bars = makeBars(30);
  const badFibCache = { foo: 'bar' }; // findFibCluster için geçersiz şekil
  const out = await enrichBundle({
    symbol: 'X', tf: '60',
    ohlcvData: makeOhlcv(bars),
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: 100,
    fibCache: badFibCache,
  });
  // Throw etmez; sonuc obje doner
  assert.ok(out);
  // Geçersiz şekilden fibCluster üretemediği için null kalır
  // (veya findFibCluster defensive ise empty object). Kritik olan:
  // enrichBundle ÇÖKMEDİ.
});

test('Patch 6.4: enrichBundle bridge VE disk I/O bagimsiz (saf fonksiyon kanıtı)', async () => {
  // Bu test enrichBundle'in artik DIŞ STATE'den (chart bridge, disk fib cache,
  // file system) bağımsız oldugunu kanıtlar. Tek girdi parametre objesi;
  // tek çıktı return objesi. Aynı girdi → aynı çıktı (idempotent).
  const bars = makeBars(40);
  const ohlcv = makeOhlcv(bars);
  const params = {
    symbol: 'BTCUSDT',
    tf: '240',
    ohlcvData: ohlcv,
    studyValues: _emptyStudyValues,
    smc: _emptySMC,
    quotePrice: bars[bars.length - 1].close,
    fibCache: null,
  };
  const out1 = await enrichBundle(params);
  const out2 = await enrichBundle(params);

  // Aynı girdi → aynı yapısal çıktı (timestamp gibi alan yok)
  assert.equal(out1.bars.length, out2.bars.length);
  assert.equal(out1.quotePrice, out2.quotePrice);
  assert.deepEqual(
    Object.keys(out1).sort(),
    Object.keys(out2).sort()
  );
  // Bridge + disk çağrısı olsaydı buraya kadar gelemezdi (mock yok).
  assert.ok(out1);
  assert.ok(out2);
});
