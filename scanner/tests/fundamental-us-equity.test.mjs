/**
 * fundamental/ — US-equity classifier + snapshot builder tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyUsEquityFundamentals } from '../lib/fundamental/stance-classifier.js';
import { buildFundamentalSnapshot } from '../lib/fundamental/index.js';
import { writeUsEquityFundamentalCache, usEquityCachePath } from '../lib/fundamental/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SYMBOL = '__TEST_FUND__';

function cleanup() {
  const f = usEquityCachePath(TEST_SYMBOL);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

test('cache yoksa overall=unknown ve freshness=missing', () => {
  cleanup();
  const snap = buildFundamentalSnapshot({ symbol: TEST_SYMBOL, category: 'abd_hisse' });
  assert.equal(snap.overall, 'unknown');
  assert.equal(snap.freshness, 'missing');
  assert.ok(snap.sections.find(s => s.key === 'data_quality'));
});

test('ABD disindaki kategorilerde snapshot null', () => {
  for (const cat of ['kripto', 'emtia', 'forex', 'bist', null, undefined]) {
    assert.equal(buildFundamentalSnapshot({ symbol: 'AAPL', category: cat }), null);
  }
});

test('fresh + pozitif metrikler -> overall=positive', () => {
  const cache = {
    schemaVersion: 1,
    symbol: 'XYZ',
    category: 'abd_hisse',
    asOf: new Date().toISOString(),
    metrics: {
      revenueGrowthYoY: 0.12, epsGrowthYoY: 0.18,
      grossMargin: 0.55, operatingMargin: 0.30, netMargin: 0.22, roe: 0.35,
      currentRatio: 1.4, debtToEquity: 1.0,
      freeCashFlow: 1e10, freeCashFlowMargin: 0.20,
      pe: 22, forwardPe: 19, evToEbitda: 18,
    },
  };
  const c = classifyUsEquityFundamentals(cache);
  assert.equal(c.freshness, 'fresh');
  assert.equal(c.overall, 'positive');
  assert.equal(c.sections.find(s => s.key === 'growth').stance, 'positive');
  assert.equal(c.sections.find(s => s.key === 'profitability').stance, 'positive');
});

test('eski cache -> data_quality=negative + freshness=stale', () => {
  const old = new Date(Date.now() - 365 * 86400000).toISOString();
  const c = classifyUsEquityFundamentals({ asOf: old, metrics: { revenueGrowthYoY: 0.1, epsGrowthYoY: 0.1 } });
  assert.equal(c.freshness, 'stale');
  assert.equal(c.sections.find(s => s.key === 'data_quality').stance, 'negative');
});

test('negatif metrik kombinasyonu -> overall=negative', () => {
  const c = classifyUsEquityFundamentals({
    asOf: new Date().toISOString(),
    metrics: {
      revenueGrowthYoY: -0.10, epsGrowthYoY: -0.20,
      grossMargin: 0.10, operatingMargin: 0.01, netMargin: -0.05, roe: 0.01,
      currentRatio: 0.7, debtToEquity: 4.0,
      freeCashFlow: -1e9, freeCashFlowMargin: -0.05,
    },
  });
  assert.equal(c.overall, 'negative');
});

test('yaklasan earnings -> event_risk=negative', () => {
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  const c = classifyUsEquityFundamentals({
    asOf: new Date().toISOString(),
    metrics: { earningsDate: soon, revenueGrowthYoY: 0.01 },
  });
  assert.equal(c.sections.find(s => s.key === 'event_risk').stance, 'negative');
});

test('round-trip cache yaz/oku ve snapshot uret', () => {
  const cache = {
    schemaVersion: 1,
    symbol: TEST_SYMBOL,
    category: 'abd_hisse',
    source: { financials: 'sec_edgar_companyfacts' },
    asOf: new Date().toISOString(),
    metrics: {
      revenueGrowthYoY: 0.08, epsGrowthYoY: 0.07,
      grossMargin: 0.40, operatingMargin: 0.18, roe: 0.20,
      currentRatio: 1.2, debtToEquity: 1.2,
      freeCashFlow: 5e9, freeCashFlowMargin: 0.15,
    },
  };
  cache.classification = classifyUsEquityFundamentals(cache);
  writeUsEquityFundamentalCache(TEST_SYMBOL, cache);

  const snap = buildFundamentalSnapshot({ symbol: TEST_SYMBOL, category: 'abd_hisse' });
  assert.equal(snap.symbol, TEST_SYMBOL);
  assert.equal(snap.overall, 'positive');
  assert.equal(snap.freshness, 'fresh');
  assert.ok(snap.metrics);
  cleanup();
});
