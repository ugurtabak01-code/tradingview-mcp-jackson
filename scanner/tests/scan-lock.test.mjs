/**
 * scanner-engine.js — chart mutex regression tests.
 *
 * Lock fix'i (2026-05-23):
 *   - FIFO devir: release sirasinda _scanActive true tutularak waiter'a aktarilir
 *     (eski 50ms setTimeout penceresi dis senkron acquire ile sira bozuyordu).
 *   - Transfer-arasi timeout: kuyrugun basindaki waiter timeout olduysa sonraki
 *     waiter'a kaydirilir (lock leak kapali).
 *
 * Bu testler mevcut davranisi kilitler; refactor sirasinda regress olursa
 * `scan-lock.test.mjs` kirmizi doner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireScanLock,
  releaseScanLock,
  drainLockQueue,
  isScanActive,
  getLockHolder,
} from '../lib/scanner-engine.js';

// Her test sonrasi global state'i temizle — testler sirali calistirilirsa
// bir test diger testin lock state'ini gormesin.
function resetLockState() {
  drainLockQueue();
  if (isScanActive()) {
    try { releaseScanLock(); } catch { /* ignore */ }
  }
}

test('basit acquire / release', async () => {
  resetLockState();
  await acquireScanLock('A');
  assert.equal(isScanActive(), true);
  assert.equal(getLockHolder(), 'A');
  releaseScanLock();
  // Microtask transfer yok → senkron temizlenmis olmali
  assert.equal(isScanActive(), false);
  assert.equal(getLockHolder(), null);
});

test('FIFO: ardisik acquire cagrilari sirayla aktive olur', async () => {
  resetLockState();
  const events = [];

  await acquireScanLock('A');
  events.push('A_acquired');

  const pB = acquireScanLock('B').then(() => events.push('B_acquired'));
  const pC = acquireScanLock('C').then(() => events.push('C_acquired'));
  const pD = acquireScanLock('D').then(() => events.push('D_acquired'));

  // A hala kilidi tutuyor
  assert.equal(getLockHolder(), 'A');
  assert.equal(events.length, 1);

  // A serbest birakir → B alir (microtask)
  releaseScanLock();
  events.push('A_released');
  await pB;
  assert.equal(getLockHolder(), 'B');

  releaseScanLock();
  events.push('B_released');
  await pC;
  assert.equal(getLockHolder(), 'C');

  releaseScanLock();
  events.push('C_released');
  await pD;
  assert.equal(getLockHolder(), 'D');

  releaseScanLock();
  assert.equal(isScanActive(), false);

  assert.deepEqual(events, [
    'A_acquired',
    'A_released', 'B_acquired',
    'B_released', 'C_acquired',
    'C_released', 'D_acquired',
  ]);
});

test('FIFO devir: release sonrasi disaridan acquire kuyrugu atlamaz', async () => {
  // Eski bug: releaseScanLock() _scanActive=false yapip 50ms setTimeout ile
  // waiter'i uyandiriyordu. Bu 50ms penceresinde dis senkron acquire kilidi
  // yakalayip kuyruktaki waiter'in onune geciyordu (FIFO ihlali).
  //
  // Yeni davranis: release _scanActive=true tutar, microtask ile waiter'a devreder.
  // Dis acquire kuyrugun sonuna duser.
  resetLockState();
  const events = [];

  await acquireScanLock('first');
  events.push('first_acquired');

  // Kuyruga gir
  const pQueued = acquireScanLock('queued').then(() => events.push('queued_acquired'));

  // first kilidini birakir — ayni anda dis aktor (queue jumper) acquire dener.
  // Yeni implementasyon: queued microtask'i ile kapar, jumper kuyruga eklenir.
  releaseScanLock();
  events.push('first_released');
  const pJumper = acquireScanLock('jumper').then(() => events.push('jumper_acquired'));

  await pQueued;
  assert.equal(getLockHolder(), 'queued', 'queued holder must precede jumper');

  releaseScanLock();
  events.push('queued_released');
  await pJumper;
  assert.equal(getLockHolder(), 'jumper');

  releaseScanLock();

  // Olay sirasi: queued ALMALI jumper'dan ONCE
  const qIdx = events.indexOf('queued_acquired');
  const jIdx = events.indexOf('jumper_acquired');
  assert.ok(qIdx >= 0 && jIdx >= 0, 'both must have acquired');
  assert.ok(qIdx < jIdx, `queued (${qIdx}) must acquire before jumper (${jIdx})`);
});

test('drainLockQueue: kuyrugun tamami reject olur, mevcut holder etkilenmez', async () => {
  resetLockState();

  await acquireScanLock('holder');
  const rejects = [];
  const pA = acquireScanLock('w1').catch(e => rejects.push(['w1', e.message]));
  const pB = acquireScanLock('w2').catch(e => rejects.push(['w2', e.message]));
  const pC = acquireScanLock('w3').catch(e => rejects.push(['w3', e.message]));

  const drained = drainLockQueue();
  assert.equal(drained, 3);

  await Promise.all([pA, pB, pC]);
  assert.equal(rejects.length, 3);
  assert.ok(rejects.every(([, msg]) => msg.includes('Kuyruk temizlendi')));

  // Holder hala kilitte
  assert.equal(getLockHolder(), 'holder');
  releaseScanLock();
  assert.equal(isScanActive(), false);
});

test('timeout: kuyrukta beklerken timeout fire ederse reject olur, lock leak yok', async () => {
  resetLockState();

  await acquireScanLock('blocker');

  // 80ms timeout ile bekle — blocker hicbir zaman release etmeyecek
  let timedOut = false;
  const start = Date.now();
  try {
    await acquireScanLock('impatient', 80);
    assert.fail('impatient should have timed out');
  } catch (e) {
    timedOut = true;
    const elapsed = Date.now() - start;
    assert.ok(e.message.includes('Timeout'));
    assert.ok(elapsed >= 70, `timeout fired too early (${elapsed}ms)`);
    assert.ok(elapsed < 500, `timeout took too long (${elapsed}ms)`);
  }
  assert.equal(timedOut, true);

  // Blocker hala kilitte
  assert.equal(getLockHolder(), 'blocker');
  releaseScanLock();
  assert.equal(isScanActive(), false);
});

test('transfer-arasi timeout: ilk waiter timeout, ikinci waiter alabilmeli', async () => {
  // Race senaryosu: blocker release ettiginde queue'da [timedOutWaiter, freshWaiter]
  // var. timedOutWaiter timer fire etti, queue'dan splice olundu, ama
  // releaseScanLock henuz tetiklenmedi. Yeni: transferNext donguyle freshWaiter'a
  // gecer; eski impl'de fresh kuyrukta kalir, _scanActive true takilirdi.
  //
  // Burada bunu deterministik kurmak zor; pratikte timer'i once fire ettirip
  // sonra release cagrarak yaklasik etkiyi olusturuyoruz.
  resetLockState();

  await acquireScanLock('blocker');

  // 30ms timeout — blocker release etmeden once fire edecek
  const pTimedOut = acquireScanLock('willTimeOut', 30).catch(e => e.message);

  // 60ms sonra fresh waiter ekle
  await new Promise(r => setTimeout(r, 60));
  const pFresh = acquireScanLock('fresh');

  // willTimeOut bu noktada zaten reject olmus olmali
  const timedOutMsg = await pTimedOut;
  assert.ok(typeof timedOutMsg === 'string' && timedOutMsg.includes('Timeout'));

  // Blocker release — fresh kapmali
  releaseScanLock();
  await pFresh;
  assert.equal(getLockHolder(), 'fresh');

  releaseScanLock();
  assert.equal(isScanActive(), false, 'lock leak: _scanActive should be false after fresh release');
});

test('release sonrasi kuyruk bossa state tamamen temizlenir', async () => {
  resetLockState();
  await acquireScanLock('solo');
  releaseScanLock();
  assert.equal(isScanActive(), false);
  assert.equal(getLockHolder(), null);

  // Tekrar al — temiz baslangic
  await acquireScanLock('again');
  assert.equal(getLockHolder(), 'again');
  releaseScanLock();
});
