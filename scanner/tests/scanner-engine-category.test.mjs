/**
 * scanner-engine.js — asset category & rules cache regression tests.
 *
 * Patch 4 (2026-05-23):
 *   - loadRules() mtime cache: rules.json statSync mtime degismedikce
 *     parsed cache return.
 *   - assignAssetCategory(symbol, watchlist) — 3 kademeli kategorize:
 *       1. Watchlist EXACT match (her seyden once)
 *       2. Index whitelist (USDT.D, BTC.D, DXY, VIX, US10Y, ...)
 *       3. Suffix/prefix kural seti (perp .P, USDT/USDC, XAU/XAG, forex pair)
 *     Eski substring listesi kaldirildi: 'SOLAR'.includes('SOL') gibi
 *     yanlis eslesmeler ortadan kalkti.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assignAssetCategory,
  loadRules,
  _resetRulesCache,
} from '../lib/scanner-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '../../rules.json');

// ---------------------------------------------------------------------------
// assignAssetCategory (saf fonksiyon — watchlist parametre olarak veriliyor)
// ---------------------------------------------------------------------------

const mockWatchlist = {
  kripto:    ['BTCUSDT.P', 'ETHUSDT.P'],
  abd_hisse: ['BA', 'GOOGL', 'PG'],
  bist:      ['PGSUS', 'AKBNK'],
  emtia:     ['XAUUSD', 'COPPER'],
  forex:     ['EURUSD'],
};

test('Patch 4: watchlist EXACT match her seyden once kazanir', () => {
  assert.equal(assignAssetCategory('BA', mockWatchlist), 'abd_hisse');
  assert.equal(assignAssetCategory('PGSUS', mockWatchlist), 'bist');
  assert.equal(assignAssetCategory('GOOGL', mockWatchlist), 'abd_hisse');
  assert.equal(assignAssetCategory('XAUUSD', mockWatchlist), 'emtia');
});

test('Patch 4: SOLAR substring tuzagi — yanlis crypto degil default', () => {
  // Eski substring kodu 'SOLAR'.includes('SOL') → 'crypto' donduruyordu.
  // Watchlist'te yoksa 'default' donmeli (suffix kuralı yok, forex degil, .P yok).
  assert.equal(assignAssetCategory('SOLAR', mockWatchlist), 'default');
});

test('Patch 4: PG vs PGSUS — substring carpisi yok', () => {
  // Watchlist exact: PG → abd_hisse, PGSUS → bist.
  // Eski substring kodu PGSUS icin yanlis eslesme yapabilirdi.
  assert.equal(assignAssetCategory('PG', mockWatchlist), 'abd_hisse');
  assert.equal(assignAssetCategory('PGSUS', mockWatchlist), 'bist');
});

test('Patch 4: index whitelist — USDT.D / BTC.D / DXY / VIX → default', () => {
  assert.equal(assignAssetCategory('USDT.D', mockWatchlist), 'default');
  assert.equal(assignAssetCategory('BTC.D', mockWatchlist), 'default');
  assert.equal(assignAssetCategory('DXY', mockWatchlist), 'default');
  assert.equal(assignAssetCategory('VIX', mockWatchlist), 'default');
  assert.equal(assignAssetCategory('US10Y', mockWatchlist), 'default');
});

test('Patch 4: suffix kuralı — USDT/USDC ile biten → crypto', () => {
  // Watchlist'te olmayan kripto sembolleri (yeni listing) suffix ile yakalanir.
  assert.equal(assignAssetCategory('SUIUSDT', mockWatchlist), 'crypto');
  assert.equal(assignAssetCategory('XRPUSDC', mockWatchlist), 'crypto');
  assert.equal(assignAssetCategory('NEWCOINUSDT', mockWatchlist), 'crypto');
});

test('Patch 4: suffix kuralı — .P (perp) → crypto', () => {
  assert.equal(assignAssetCategory('LINKUSDT.P', mockWatchlist), 'crypto');
  assert.equal(assignAssetCategory('AVAXUSD.P', mockWatchlist), 'crypto');
});

test('Patch 4: emtia — XAU/XAG ile baslayan veya biten', () => {
  // Watchlist'te olmayan emtia sembolleri
  assert.equal(assignAssetCategory('XAUEUR', mockWatchlist), 'emtia');
  assert.equal(assignAssetCategory('USDXAU', mockWatchlist), 'emtia');
  assert.equal(assignAssetCategory('XAGEUR', mockWatchlist), 'emtia');
});

test('Patch 4: forex — bilinen 6-letter pair', () => {
  assert.equal(assignAssetCategory('GBPUSD', mockWatchlist), 'forex');
  assert.equal(assignAssetCategory('USDJPY', mockWatchlist), 'forex');
  assert.equal(assignAssetCategory('AUDUSD', mockWatchlist), 'forex');
});

test('Patch 4: forex pair OLMAYAN 6-letter sembol → default (false-positive yok)', () => {
  // Eski substring kodu 'EURUSD'.includes('EURUSD') yapardi ama 'XXXUSD' false-positive
  // riski yoktu. Yeni kodda exact match — yanlis yakalama yok.
  assert.equal(assignAssetCategory('FOOBAR', mockWatchlist), 'default');
});

test('Patch 4: exchange prefix (BINANCE:BTCUSDT) handle edilir', () => {
  assert.equal(assignAssetCategory('BINANCE:BTCUSDT', mockWatchlist), 'crypto');
  assert.equal(assignAssetCategory('NASDAQ:GOOGL', mockWatchlist), 'abd_hisse');
});

test('Patch 4: null/undefined/bos symbol → default (defensive)', () => {
  assert.equal(assignAssetCategory(null, mockWatchlist), 'default');
  assert.equal(assignAssetCategory(undefined, mockWatchlist), 'default');
  assert.equal(assignAssetCategory('', mockWatchlist), 'default');
});

test('Patch 4: watchlist null → suffix/index kurallarına dus', () => {
  // Watchlist parametresi olmadan da kategorize calismali (degraded mode).
  assert.equal(assignAssetCategory('BTCUSDT', null), 'crypto');
  assert.equal(assignAssetCategory('USDT.D', null), 'default');
  assert.equal(assignAssetCategory('SOLAR', null), 'default'); // exact yok → default
});

// ---------------------------------------------------------------------------
// loadRules mtime cache
// ---------------------------------------------------------------------------

test('Patch 4: loadRules ilk cagri parse eder, ikinci cagri cache hit', () => {
  _resetRulesCache();
  const r1 = loadRules();
  const r2 = loadRules();
  // Cache hit referans-eslik ile dogrulanir (yeniden parse edilseydi yeni object olurdu)
  assert.equal(r1, r2, 'cache hit: ayni referans dönmeli');
});

test('Patch 4: rules.json mtime degisirse cache invalidate', () => {
  _resetRulesCache();
  const r1 = loadRules();
  // Aynı dosyaya bir kez daha aynı içeriği yazıp mtime'ı değiştir
  const originalContent = fs.readFileSync(RULES_PATH, 'utf-8');
  try {
    // utimesync ile mtime'i kucuk bir sapma ile ileri al
    const now = Date.now() / 1000;
    fs.utimesSync(RULES_PATH, now, now + 1);
    const r2 = loadRules();
    assert.notEqual(r1, r2, 'mtime degisti: cache invalidate, yeni parse');
    // Içerik aynı olmali (sadece mtime degisti)
    assert.deepEqual(Object.keys(r1.watchlist), Object.keys(r2.watchlist));
  } finally {
    // Içerik aynı kaldı, mtime restore gerek yok (test sonrasi loadRules tekrar parse eder)
    fs.writeFileSync(RULES_PATH, originalContent);
    _resetRulesCache();
  }
});

test('Patch 4: _resetRulesCache cache\'i sifirlar', () => {
  const r1 = loadRules();
  _resetRulesCache();
  const r2 = loadRules();
  assert.notEqual(r1, r2, 'cache reset sonrasi yeni parse');
});
