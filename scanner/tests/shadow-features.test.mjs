import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeShadowFeatures,
  SHADOW_FEATURES_VERSION,
} from '../lib/learning/shadow-features.js';

const find = (sf, key) => sf.features.find(f => f.key === key);

test('returns versioned payload with all feature families', () => {
  const sf = computeShadowFeatures({});
  assert.equal(sf.shadowFeaturesVersion, SHADOW_FEATURES_VERSION);
  assert.ok(typeof sf.computedAt === 'string');
  const families = new Set(sf.features.map(f => f.family));
  for (const fam of ['extreme_extension', 'volatility_regime',
    'htf_path_obstruction', 'volume_quality', 'category_context']) {
    assert.ok(families.has(fam), `family ${fam} present`);
  }
});

test('every feature record carries the standard schema', () => {
  const sf = computeShadowFeatures({});
  for (const f of sf.features) {
    for (const k of ['family', 'key', 'source', 'raw', 'normalized',
      'riskFlag', 'categoryApplicable', 'missingReason', 'mode']) {
      assert.ok(k in f, `${f.key} has field ${k}`);
    }
    assert.ok(f.mode === 'backfill' || f.mode === 'forward');
  }
});

test('missing data is null riskFlag/normalized, never false', () => {
  const sf = computeShadowFeatures({}); // empty signal -> everything missing
  for (const f of sf.features) {
    if (f.missingReason) {
      assert.equal(f.riskFlag, null, `${f.key} riskFlag null when missing`);
      assert.equal(f.normalized, null, `${f.key} normalized null when missing`);
    }
  }
});

test('rsi_extreme flags climax in trade direction (long, overbought)', () => {
  const sf = computeShadowFeatures({
    direction: 'long',
    indicators: { khanSaab: { rsi: 92.5 } },
  });
  const f = find(sf, 'rsi_extreme');
  assert.equal(f.mode, 'backfill');
  assert.equal(f.riskFlag, true);
  assert.equal(f.raw.rsi, 92.5);
  assert.ok(f.normalized > 0.9);
});

test('rsi_extreme does not flag a healthy long', () => {
  const sf = computeShadowFeatures({
    direction: 'long',
    indicators: { khanSaab: { rsi: 55 } },
  });
  const f = find(sf, 'rsi_extreme');
  assert.equal(f.riskFlag, false);
});

test('rsi_extreme missing when rsi absent', () => {
  const sf = computeShadowFeatures({ direction: 'long', indicators: {} });
  const f = find(sf, 'rsi_extreme');
  assert.equal(f.missingReason, 'rsi_unavailable');
  assert.equal(f.riskFlag, null);
});

test('regime_quality flags chaos regimes', () => {
  assert.equal(find(computeShadowFeatures({ regime: 'high_vol_chaos' }), 'regime_quality').riskFlag, true);
  assert.equal(find(computeShadowFeatures({ regime: 'trending_up' }), 'regime_quality').riskFlag, false);
  assert.equal(find(computeShadowFeatures({}), 'regime_quality').missingReason, 'regime_unavailable');
});

test('tp_path_obstruction flags a barrier between entry and tp1 (long)', () => {
  const sf = computeShadowFeatures({
    direction: 'long', entry: 100, tp1: 110, tp2: 120,
    barrierSummary: {
      above: [{ price: 105, strength: 9, tf: '1D', zoneLow: 105, zoneHigh: 105 }],
      below: [],
    },
  });
  const f = find(sf, 'tp_path_obstruction');
  assert.equal(f.mode, 'backfill');
  assert.equal(f.riskFlag, true);
  assert.equal(f.raw.barriersBeforeTp1, 1);
});

test('tp_path_obstruction clear when barrier is past tp1', () => {
  const sf = computeShadowFeatures({
    direction: 'long', entry: 100, tp1: 110, tp2: 120,
    barrierSummary: { above: [{ price: 130, strength: 9, tf: '1W' }], below: [] },
  });
  const f = find(sf, 'tp_path_obstruction');
  assert.equal(f.riskFlag, false);
  assert.equal(f.raw.barriersBeforeTp1, 0);
});

test('barrier_proximity flags a barrier closer than 1.3x SL distance', () => {
  const sf = computeShadowFeatures({
    direction: 'long', entry: 100, sl: 95, atr: 2,
    barrierSummary: { above: [{ price: 103, strength: 7, tf: '1D' }], below: [] },
  });
  const f = find(sf, 'barrier_proximity');
  assert.equal(f.riskFlag, true); // dist 3 < 1.3 * 5 = 6.5
  assert.equal(f.raw.distanceAtr, 1.5);
});

test('barrierSummary present but empty TP side = riskFlag false, not missing', () => {
  const sf = computeShadowFeatures({
    direction: 'long', entry: 100, tp1: 110, tp2: 120, sl: 95,
    barrierSummary: { above: [], below: [{ price: 90, strength: 5 }] },
  });
  const prox = find(sf, 'barrier_proximity');
  assert.equal(prox.missingReason, null);
  assert.equal(prox.riskFlag, false);
  const obstr = find(sf, 'tp_path_obstruction');
  assert.equal(obstr.missingReason, null);
  assert.equal(obstr.riskFlag, false);
});

test('barrier zone overlapping the TP leg is detected even if price is outside', () => {
  // representative price 112 is past tp1=110, but the zone [108,114] straddles it
  const sf = computeShadowFeatures({
    direction: 'long', entry: 100, tp1: 110, tp2: 120,
    barrierSummary: {
      above: [{ price: 112, zoneLow: 108, zoneHigh: 114, strength: 8, tf: '1D' }],
      below: [],
    },
  });
  const f = find(sf, 'tp_path_obstruction');
  assert.equal(f.riskFlag, true);
  assert.equal(f.raw.barriersBeforeTp1, 1);
});

test('barrier_proximity measures distance to near zone edge', () => {
  const sf = computeShadowFeatures({
    direction: 'long', entry: 100, sl: 95, atr: 2,
    barrierSummary: { above: [{ price: 120, zoneLow: 106, zoneHigh: 124, strength: 7 }], below: [] },
  });
  const f = find(sf, 'barrier_proximity');
  assert.equal(f.raw.distanceAbs, 6); // near edge 106, not center 120
});

test('htf features missing when barrierSummary absent', () => {
  const sf = computeShadowFeatures({ direction: 'long', entry: 100, tp1: 110 });
  assert.equal(find(sf, 'tp_path_obstruction').missingReason, 'barrier_or_levels_unavailable');
  assert.equal(find(sf, 'barrier_proximity').missingReason, 'barrier_or_entry_unavailable');
});

test('cmf_mfi_alignment flags volume flow against a long trade', () => {
  const sf = computeShadowFeatures({
    direction: 'long',
    shadowMetrics: { cmf: { cmf: -0.2, bias: 'supply' }, mfi: { cur: 30 } },
  });
  const f = find(sf, 'cmf_mfi_alignment');
  assert.equal(f.mode, 'backfill');
  assert.equal(f.riskFlag, true);
});

test('cmf_mfi_alignment missing when shadowMetrics absent', () => {
  const sf = computeShadowFeatures({ direction: 'long' });
  const f = find(sf, 'cmf_mfi_alignment');
  assert.equal(f.missingReason, 'shadowMetrics_unavailable');
});

test('category_context features are forward-only with applicability', () => {
  const sf = computeShadowFeatures({ category: 'crypto' });
  const crypto = find(sf, 'crypto_market_context');
  assert.equal(crypto.mode, 'forward');
  assert.equal(crypto.categoryApplicable, true);
  assert.equal(crypto.missingReason, 'external_data_excluded_v1');
  assert.equal(find(sf, 'us_equity_context').categoryApplicable, false);
});

test('forward extension/volume features never fabricate values', () => {
  const sf = computeShadowFeatures({ direction: 'long', indicators: { khanSaab: { rsi: 90 } } });
  for (const key of ['ema_vwap_distance', 'atr_zscore', 'volume_climax',
    'atr_percentile', 'bb_width_expansion', 'volume_zscore', 'obv_divergence']) {
    const f = find(sf, key);
    assert.equal(f.mode, 'forward');
    assert.equal(f.riskFlag, null);
    assert.equal(f.normalized, null);
    assert.ok(f.missingReason);
  }
});

test('computeShadowFeatures does not mutate the input signal', () => {
  const signal = { direction: 'long', entry: 100, tp1: 110,
    indicators: { khanSaab: { rsi: 80 } } };
  const snapshot = JSON.stringify(signal);
  computeShadowFeatures(signal);
  assert.equal(JSON.stringify(signal), snapshot);
});
