/**
 * bridge-timeout.js — CDP roundtrip timeout helper.
 *
 * Motivasyon: CDP donarsa scanner suresiz bekler ve chart-mutex bloke
 * olur. withCdpTimeout op-spesifik timeout ile Promise.race koyup
 * CdpTimeoutError fırlatır; çağıran (.catch yutsa bile) TF HATA
 * grade'iyle düşer, scanShortTerm finally bloku ile mutex serbest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_TIMEOUTS,
  CdpTimeoutError,
  withCdpTimeout,
  isCdpTimeoutError,
  recordCdpSuccess,
  recordCdpTimeout,
  shouldReconnect,
  clearReconnectFlag,
  _getCdpCounterState,
} from '../lib/bridge-timeout.js';

// Yardımcılar
const never = () => new Promise(() => {}); // hiç dönmeyen promise
const delay = (ms, value) => new Promise(r => setTimeout(() => r(value), ms));
const failAfter = (ms, err) => new Promise((_, rej) => setTimeout(() => rej(err), ms));

// Test sırasında uzun süre beklememek için BRIDGE_TIMEOUTS okunan ama
// withCdpTimeout'a verilen op'lara karşılık kısa default değerler kontrol et.
// Gerçek default değerler 8-30s; testlerde özel op kullanıp env override yapamayız
// (modül load'unda okunuyor). Bu yüzden testler `default` fallback üzerinden
// ÇOK küçük timeoutlu özel bir op kullanır — modülü yeniden yüklemek yerine
// withCdpTimeout'un default fallback yolu test edilir.

test('BRIDGE_TIMEOUTS: tüm temel op anahtarları tanımlı', () => {
  const required = [
    'setSymbol', 'setTimeframe', 'getOhlcv', 'getOhlcvValidated',
    'getStudyValues', 'getQuote', 'getCurrentBareSymbol',
    'getChartState', 'readSMC', 'default',
  ];
  for (const k of required) {
    assert.ok(BRIDGE_TIMEOUTS[k] > 0, `${k} timeout > 0 olmali`);
    assert.ok(Number.isFinite(BRIDGE_TIMEOUTS[k]), `${k} sayisal olmali`);
  }
});

test('BRIDGE_TIMEOUTS: setSymbol en yüksek (chart yüklemesi)', () => {
  // Tasarim karari: setSymbol 30s default; getCurrentBareSymbol/chartState 8s.
  assert.ok(BRIDGE_TIMEOUTS.setSymbol >= BRIDGE_TIMEOUTS.getQuote);
  assert.ok(BRIDGE_TIMEOUTS.setSymbol >= BRIDGE_TIMEOUTS.getCurrentBareSymbol);
});

test('CdpTimeoutError: code, op, timeoutMs, message', () => {
  const err = new CdpTimeoutError('setSymbol', 30000);
  assert.equal(err.code, 'CDP_TIMEOUT');
  assert.equal(err.op, 'setSymbol');
  assert.equal(err.timeoutMs, 30000);
  assert.equal(err.name, 'CdpTimeoutError');
  assert.ok(err.message.includes('CDP_TIMEOUT'));
  assert.ok(err.message.includes('setSymbol'));
  assert.ok(err.message.includes('30000'));
  assert.ok(err instanceof Error);
});

test('isCdpTimeoutError: code-based ayırım', () => {
  assert.equal(isCdpTimeoutError(new CdpTimeoutError('x', 1)), true);
  assert.equal(isCdpTimeoutError(new Error('generic')), false);
  assert.equal(isCdpTimeoutError(null), false);
  assert.equal(isCdpTimeoutError({ code: 'CDP_TIMEOUT' }), true);
});

test('withCdpTimeout: promise zamanında resolve ederse sonucu döner', async () => {
  const result = await withCdpTimeout(delay(20, 'ok'), 'getCurrentBareSymbol');
  assert.equal(result, 'ok');
});

test('withCdpTimeout: promise zamanında reject ederse hata propagate', async () => {
  const customErr = new Error('bridge internal failure');
  try {
    await withCdpTimeout(failAfter(20, customErr), 'getCurrentBareSymbol');
    assert.fail('reject beklenir');
  } catch (e) {
    // CDP_TIMEOUT DEĞİL — orijinal hata
    assert.equal(e, customErr);
    assert.ok(!isCdpTimeoutError(e));
  }
});

// Asıl davranış testleri — kısa timeout için BRIDGE_TIMEOUTS.default'u manuel
// override etmek yerine, modül içindeki sabit değer üzerinden çalışıyoruz.
// 8000ms gerçek default — test suite'i bunu beklemesin diye, biz `unknownOp`
// kullanmak yerine helper'a override geçirme imkanı yok. Çözüm: testte gerçekten
// 8s+ beklemek yerine, modülü dinamik import ederek BRIDGE_TIMEOUTS'u alıyoruz
// ve withCdpTimeout'un `op` parametresinin BRIDGE_TIMEOUTS[op] okuduğunu
// doğrudan kanıtlıyoruz — never promise + bilinen kısa op kullanılarak.
//
// Pragmatik: BRIDGE_TIMEOUTS.default genelde 10s. Testin 10s beklemesi kabul
// edilemez. Bunun yerine env var ile override edilmiş çalışan ayrı bir
// import yapıyoruz.

test('withCdpTimeout: never-promise → timeout fire → CdpTimeoutError', async () => {
  // Bu test BRIDGE_TIMEOUTS.getCurrentBareSymbol = 8000 default ile çalışır;
  // 8s beklemeyi kabul ediyoruz (en küçük default). Daha hızlı bir yol için
  // BRIDGE_TIMEOUT_BARE_SYM=100 env var ile yeniden import gerekir — bu
  // process-level state, test izolasyonu için ideal değil.
  //
  // Alternatif: getCurrentBareSymbol'ün default 8000'ini değil, kısa bir
  // değer kullan. BRIDGE_TIMEOUTS'a doğrudan mutasyon → modül içi state'i
  // bozar. En temiz: dinamik import ile env override.
  const start = Date.now();
  // Modul yuklemesini takip etmek icin env override + dinamik import
  process.env.BRIDGE_TIMEOUT_FOR_TEST_OP = '120';
  // Direkt withCdpTimeout'u kullan: BRIDGE_TIMEOUTS objesi key'i bilinmiyorsa
  // default'a düşer. Burada bilinmeyen op verip default'u override edelim:
  // BRIDGE_TIMEOUT_DEFAULT env yalnız initial load'da okunur. Bu testte
  // 8000ms beklemek yerine alternatif: BRIDGE_TIMEOUTS objesini test
  // başında mutate et (bu modülde mutable export — assignment ile değil
  // property update ile çalışır).

  // BRIDGE_TIMEOUTS.default'u test sırasında geçici olarak 120 yap.
  const original = BRIDGE_TIMEOUTS.default;
  BRIDGE_TIMEOUTS.default = 120;
  try {
    let caught = null;
    try {
      await withCdpTimeout(never(), '__test_unknown_op__');
      assert.fail('timeout beklenir');
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    assert.ok(isCdpTimeoutError(caught), 'CdpTimeoutError olmali');
    assert.equal(caught.op, '__test_unknown_op__');
    assert.equal(caught.timeoutMs, 120);
    assert.ok(elapsed >= 100, `timeout cok erken fire etti (${elapsed}ms)`);
    assert.ok(elapsed < 600, `timeout cok gec fire etti (${elapsed}ms)`);
  } finally {
    BRIDGE_TIMEOUTS.default = original;
    delete process.env.BRIDGE_TIMEOUT_FOR_TEST_OP;
  }
});

test('withCdpTimeout: timer leak yok — promise resolve sonrasi timer cleanup', async () => {
  // Çok kısa timeout'lu bir op ile resolve ettir; pending timer kalmamalı.
  // Node testpid'i kapanırken pending timer varsa "process did not exit"
  // uyarısı verir. Burada eşdeğer kontrol: birden çok yoğun resolve serisi.
  const original = BRIDGE_TIMEOUTS.default;
  BRIDGE_TIMEOUTS.default = 5000; // büyük timeout — fire etmesin
  try {
    const start = Date.now();
    const results = await Promise.all([
      withCdpTimeout(delay(10, 'a'), '__noop1__'),
      withCdpTimeout(delay(10, 'b'), '__noop2__'),
      withCdpTimeout(delay(10, 'c'), '__noop3__'),
    ]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    const elapsed = Date.now() - start;
    // 5s timer fire etmemeli — testin kendisi ~20ms sürmeli
    assert.ok(elapsed < 1000, `cleanup gecikmesi (${elapsed}ms)`);
  } finally {
    BRIDGE_TIMEOUTS.default = original;
  }
});

test('withCdpTimeout: op BRIDGE_TIMEOUTS\'ta tanımlıysa o değeri kullanır', async () => {
  // getCurrentBareSymbol = 8000; default geçici değer
  const originalBare = BRIDGE_TIMEOUTS.getCurrentBareSymbol;
  BRIDGE_TIMEOUTS.getCurrentBareSymbol = 80;
  try {
    let caught = null;
    try {
      await withCdpTimeout(never(), 'getCurrentBareSymbol');
    } catch (e) {
      caught = e;
    }
    assert.equal(caught?.op, 'getCurrentBareSymbol');
    assert.equal(caught?.timeoutMs, 80, 'op-spesifik degeri kullanmali');
  } finally {
    BRIDGE_TIMEOUTS.getCurrentBareSymbol = originalBare;
  }
});

test('withCdpTimeout: scan finally pattern → mutex serbest', async () => {
  // Kullanim modelini simule eden integration-flavored test.
  // try/finally icindeki releaseMock CdpTimeoutError raise olsa bile cagrilir.
  let released = false;
  const originalBare = BRIDGE_TIMEOUTS.getCurrentBareSymbol;
  BRIDGE_TIMEOUTS.getCurrentBareSymbol = 50;
  try {
    try {
      await withCdpTimeout(never(), 'getCurrentBareSymbol');
    } catch (e) {
      // Beklenen
    } finally {
      released = true;
    }
    assert.equal(released, true, 'finally cagrilmali — lock release garantisi');
  } finally {
    BRIDGE_TIMEOUTS.getCurrentBareSymbol = originalBare;
  }
});

// ---------------------------------------------------------------------------
// Patch 3b — Consecutive timeout sayacı + reconnect bayrağı
// ---------------------------------------------------------------------------

test('Patch 3b: recordCdpSuccess sayacı sıfırlar', () => {
  clearReconnectFlag();
  recordCdpTimeout(); recordCdpTimeout();
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 2);
  recordCdpSuccess();
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 0);
  assert.equal(_getCdpCounterState().needsReconnect, false);
});

test('Patch 3b: recordCdpTimeout sayacı artırır', () => {
  clearReconnectFlag();
  recordCdpTimeout();
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 1);
  recordCdpTimeout();
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 2);
});

test('Patch 3b: N=3 eşiğinde reconnect bayrağı set edilir', () => {
  clearReconnectFlag();
  assert.equal(shouldReconnect(), false);
  recordCdpTimeout();
  recordCdpTimeout();
  assert.equal(shouldReconnect(), false, '2. timeout reconnect tetiklememeli');
  recordCdpTimeout();
  assert.equal(shouldReconnect(), true, '3. timeout reconnect tetiklemeli');
});

test('Patch 3b: clearReconnectFlag hem bayrağı hem sayacı sıfırlar', () => {
  clearReconnectFlag();
  recordCdpTimeout(); recordCdpTimeout(); recordCdpTimeout();
  assert.equal(shouldReconnect(), true);
  clearReconnectFlag();
  assert.equal(shouldReconnect(), false);
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 0);
});

test('Patch 3b: araya giren başarı reconnect tetiklemeyi engeller', () => {
  // Tek tek hıçkırık → ardışık değil. 2 timeout + 1 başarı + 2 timeout reconnect ETMEMELI.
  clearReconnectFlag();
  recordCdpTimeout(); recordCdpTimeout();
  recordCdpSuccess(); // ardışıklık kırıldı
  recordCdpTimeout(); recordCdpTimeout();
  assert.equal(shouldReconnect(), false, 'aradaki basari sayaci sifirlamali');
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 2);
});

test('Patch 3b: withCdpTimeout başarısı sayacı otomatik sıfırlar', async () => {
  clearReconnectFlag();
  recordCdpTimeout(); recordCdpTimeout();
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 2);
  // delay 10ms başarılı — withCdpTimeout sayacı sıfırlamalı
  await withCdpTimeout(new Promise(r => setTimeout(() => r('ok'), 10)), 'getCurrentBareSymbol');
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 0);
});

test('Patch 3b: withCdpTimeout timeout sayacı otomatik artırır', async () => {
  clearReconnectFlag();
  const originalBare = BRIDGE_TIMEOUTS.getCurrentBareSymbol;
  BRIDGE_TIMEOUTS.getCurrentBareSymbol = 50;
  try {
    try {
      await withCdpTimeout(new Promise(() => {}), 'getCurrentBareSymbol');
    } catch (e) { /* expected */ }
    assert.equal(_getCdpCounterState().consecutiveTimeouts, 1);
    try {
      await withCdpTimeout(new Promise(() => {}), 'getCurrentBareSymbol');
    } catch (e) { /* expected */ }
    assert.equal(_getCdpCounterState().consecutiveTimeouts, 2);
  } finally {
    BRIDGE_TIMEOUTS.getCurrentBareSymbol = originalBare;
    clearReconnectFlag();
  }
});

test('Patch 3b: CDP timeout DIŞINDA hata sayacı artırmaz', async () => {
  // Custom error (timeout değil) → recordCdpTimeout çağrılmamalı.
  clearReconnectFlag();
  try {
    await withCdpTimeout(Promise.reject(new Error('not a timeout')), 'getCurrentBareSymbol');
  } catch (e) { /* expected */ }
  assert.equal(_getCdpCounterState().consecutiveTimeouts, 0, 'non-timeout hata sayaci artirmamali');
});
