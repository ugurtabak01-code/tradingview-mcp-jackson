/**
 * Shadow Features — orthogonal telemetry candidates.
 *
 * SAFETY CONTRACT (do not break):
 *   - These functions are READ-ONLY. They never mutate the signal.
 *   - The returned object is attached as `signal.shadowFeatures` and is NEVER
 *     read by any live decision path: grade, direction, tally, rr, entry, sl,
 *     tp, position_pct, league, wrapper, scheduler, OKX dispatch.
 *   - Pure: no fetches, no external APIs, no shadow-primitive recomputation.
 *     Family 1/2/4 backfill features reuse already-computed values that live
 *     on the signal (indicators, shadowMetrics, barrierSummary, atr).
 *   - v1 is refetch-free. Features that would need OHLCV series or external
 *     market data emit a `forward`-mode placeholder with a missingReason —
 *     no fabricated/proxied history.
 *
 * Each feature record carries the versioned schema:
 *   { family, key, source, raw, normalized, riskFlag, categoryApplicable,
 *     missingReason, mode }
 * `mode` is the computability class:
 *   - 'backfill' : derivable from stored signal fields (works on archive too)
 *   - 'forward'  : only available on new signals once a future source lands;
 *                  in v1 always emits missingReason (never a fake value)
 */

export const SHADOW_FEATURES_VERSION = 1;

const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 25;

const CRYPTO_CATS = new Set(['crypto', 'kripto']);
const US_CATS = new Set(['us_stock', 'abd_hisse']);
const FX_COMM_CATS = new Set(['forex', 'commodity', 'emtia']);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return null;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Build one feature record. Missing-data is represented safely:
 * riskFlag/normalized stay null (never false) when data is absent.
 */
function feature({ family, key, source, mode, raw = null, normalized = null,
                    riskFlag = null, categoryApplicable = true, missingReason = null }) {
  if (missingReason) {
    return { family, key, source, mode, raw: raw ?? null, normalized: null,
             riskFlag: null, categoryApplicable, missingReason };
  }
  return { family, key, source, mode, raw, normalized, riskFlag, categoryApplicable,
           missingReason: null };
}

// ─── Family 1: extreme extension / climax ───────────────────────────────────

function rsiExtreme(signal) {
  const rsi = num(signal?.indicators?.khanSaab?.rsi);
  const dir = signal?.direction;
  if (rsi == null) {
    return feature({ family: 'extreme_extension', key: 'rsi_extreme',
      source: 'indicators.khanSaab.rsi', mode: 'backfill',
      missingReason: 'rsi_unavailable' });
  }
  // Climax risk = momentum stretched in the trade's own direction.
  const riskFlag = (dir === 'long' && rsi >= RSI_OVERBOUGHT)
                || (dir === 'short' && rsi <= RSI_OVERSOLD);
  // normalized: 0 at neutral (50), 1 at the extreme threshold, in trade dir.
  let normalized = null;
  if (dir === 'long') normalized = clamp01((rsi - 50) / (RSI_OVERBOUGHT - 50));
  else if (dir === 'short') normalized = clamp01((50 - rsi) / (50 - RSI_OVERSOLD));
  return feature({ family: 'extreme_extension', key: 'rsi_extreme',
    source: 'indicators.khanSaab.rsi', mode: 'backfill',
    raw: { rsi, direction: dir ?? null, overbought: RSI_OVERBOUGHT, oversold: RSI_OVERSOLD },
    normalized, riskFlag });
}

function forwardExtension(key, source, reason) {
  return feature({ family: 'extreme_extension', key, source, mode: 'forward',
    missingReason: reason });
}

// ─── Family 2: volatility regime quality ────────────────────────────────────

function regimeQuality(signal) {
  const regime = signal?.regime;
  if (!regime || typeof regime !== 'string') {
    return feature({ family: 'volatility_regime', key: 'regime_quality',
      source: 'signal.regime', mode: 'backfill', missingReason: 'regime_unavailable' });
  }
  const chaos = /chaos|whipsaw/i.test(regime);
  return feature({ family: 'volatility_regime', key: 'regime_quality',
    source: 'signal.regime', mode: 'backfill',
    raw: { regime }, normalized: chaos ? 1 : 0, riskFlag: chaos });
}

function forwardVolatility(key, source, reason) {
  return feature({ family: 'volatility_regime', key, source, mode: 'forward',
    missingReason: reason });
}

// ─── Family 3: HTF path obstruction ─────────────────────────────────────────

/**
 * Barriers on the trade's TP side. Returns null only when the inputs needed
 * to even attempt the computation are absent (barrierSummary / entry /
 * direction). An empty array means barrierSummary exists but the TP side has
 * no barriers — that is "no obstruction", NOT missing data.
 * Each barrier carries a zone [lo, hi] (zoneLow/zoneHigh, falling back to the
 * representative price when the zone fields are absent).
 */
function barriersOnPath(signal) {
  const bs = signal?.barrierSummary;
  const entry = num(signal?.entry);
  const dir = signal?.direction;
  if (!bs || entry == null || (dir !== 'long' && dir !== 'short')) return null;
  const list = dir === 'long' ? bs.above : bs.below;
  if (!Array.isArray(list)) return [];
  return list.map(b => {
    const price = num(b.price);
    const zLo = num(b.zoneLow);
    const zHi = num(b.zoneHigh);
    const lo = zLo != null ? Math.min(zLo, zHi ?? zLo) : price;
    const hi = zHi != null ? Math.max(zLo ?? zHi, zHi) : price;
    return { price, strength: num(b.strength), tf: b.tf ?? null, lo, hi };
  }).filter(b => b.price != null || (b.lo != null && b.hi != null));
}

/** Distance from `entry` to the near edge of a barrier zone (0 if inside). */
function edgeDistance(entry, b) {
  const lo = b.lo != null ? b.lo : b.price;
  const hi = b.hi != null ? b.hi : b.price;
  if (entry >= lo && entry <= hi) return 0;
  return Math.min(Math.abs(entry - lo), Math.abs(entry - hi));
}

function tpPathObstruction(signal) {
  const src = 'barrierSummary + entry/tp1/tp2';
  const path = barriersOnPath(signal);
  const entry = num(signal?.entry);
  const tp1 = num(signal?.tp1);
  const tp2 = num(signal?.tp2);
  if (path == null || entry == null || tp1 == null) {
    return feature({ family: 'htf_path_obstruction', key: 'tp_path_obstruction',
      source: src, mode: 'backfill', missingReason: 'barrier_or_levels_unavailable' });
  }
  const dir = signal.direction;
  // A barrier obstructs a leg if its zone [lo,hi] overlaps the entry→tp
  // segment — not just when its representative price falls inside.
  const obstructs = (b, tp) => {
    const a = Math.min(entry, tp), z = Math.max(entry, tp);
    const lo = b.lo != null ? b.lo : b.price;
    const hi = b.hi != null ? b.hi : b.price;
    return hi >= a && lo <= z;
  };
  const inTp1 = path.filter(b => obstructs(b, tp1));
  const inTp2 = tp2 != null ? path.filter(b => obstructs(b, tp2)) : [];
  const strengthTp1 = inTp1.reduce((a, b) => a + (b.strength || 0), 0);
  // Nearest barrier to entry on the path (near-edge distance).
  let nearest = null;
  for (const b of path) {
    const d = edgeDistance(entry, b);
    if (nearest == null || d < nearest.dist) nearest = { ...b, dist: d };
  }
  const riskFlag = inTp1.length > 0;
  // normalized: cumulative strength obstructing the tp1 leg, soft-capped.
  const normalized = clamp01(strengthTp1 / 15);
  return feature({ family: 'htf_path_obstruction', key: 'tp_path_obstruction',
    source: src, mode: 'backfill',
    raw: {
      direction: dir,
      barriersBeforeTp1: inTp1.length,
      barriersBeforeTp2: inTp2.length,
      strengthBeforeTp1: Math.round(strengthTp1 * 100) / 100,
      nearestBarrierPrice: nearest ? nearest.price : null,
      nearestBarrierStrength: nearest ? nearest.strength : null,
    },
    normalized, riskFlag });
}

function barrierProximity(signal) {
  const src = 'barrierSummary + entry + atr + sl';
  const path = barriersOnPath(signal);
  const entry = num(signal?.entry);
  const sl = num(signal?.sl);
  const atr = num(signal?.atr);
  if (path == null || entry == null) {
    return feature({ family: 'htf_path_obstruction', key: 'barrier_proximity',
      source: src, mode: 'backfill', missingReason: 'barrier_or_entry_unavailable' });
  }
  // barrierSummary exists but the TP side has no barriers → no obstruction,
  // a genuine riskFlag:false observation (NOT missing data).
  if (path.length === 0) {
    return feature({ family: 'htf_path_obstruction', key: 'barrier_proximity',
      source: src, mode: 'backfill',
      raw: { nearestBarrierPrice: null, barriersOnPath: 0 },
      normalized: 0, riskFlag: false });
  }
  let nearest = null;
  for (const b of path) {
    const d = edgeDistance(entry, b);
    if (nearest == null || d < nearest.dist) nearest = { ...b, dist: d };
  }
  const slDist = sl != null ? Math.abs(entry - sl) : null;
  // Mirrors the live "barrier too close" rule: within 1.3x the SL distance.
  const riskFlag = slDist != null && slDist > 0 ? nearest.dist < slDist * 1.3 : null;
  const distAtr = atr != null && atr > 0 ? nearest.dist / atr : null;
  const distPct = entry !== 0 ? (nearest.dist / Math.abs(entry)) * 100 : null;
  // normalized: closer barrier => higher score (1 at 0 distance, 0 at >=2x SL).
  let normalized = null;
  if (slDist != null && slDist > 0) normalized = clamp01(1 - nearest.dist / (slDist * 2));
  return feature({ family: 'htf_path_obstruction', key: 'barrier_proximity',
    source: src, mode: 'backfill',
    raw: {
      nearestBarrierPrice: nearest.price,
      nearestBarrierStrength: nearest.strength,
      nearestBarrierTf: nearest.tf,
      distanceAbs: Math.round(nearest.dist * 1e6) / 1e6,
      distanceAtr: distAtr != null ? Math.round(distAtr * 1000) / 1000 : null,
      distancePct: distPct != null ? Math.round(distPct * 1000) / 1000 : null,
      slDistance: slDist,
    },
    normalized, riskFlag });
}

// ─── Family 4: volume quality ───────────────────────────────────────────────

function cmfMfiAlignment(signal) {
  const src = 'shadowMetrics.cmf + shadowMetrics.mfi';
  const sm = signal?.shadowMetrics;
  const dir = signal?.direction;
  const cmf = sm?.cmf;
  const mfi = sm?.mfi;
  if (!sm || (cmf == null && mfi == null)) {
    return feature({ family: 'volume_quality', key: 'cmf_mfi_alignment',
      source: src, mode: 'backfill', missingReason: 'shadowMetrics_unavailable' });
  }
  if (dir !== 'long' && dir !== 'short') {
    return feature({ family: 'volume_quality', key: 'cmf_mfi_alignment',
      source: src, mode: 'backfill', missingReason: 'direction_unavailable' });
  }
  const cmfVal = num(cmf?.cmf);
  const cmfBias = cmf?.bias ?? null; // 'demand' | 'supply' | null
  const mfiCur = num(mfi?.cur);
  // Flow agreement with the trade direction.
  let cmfAgrees = null;
  if (cmfBias === 'demand') cmfAgrees = dir === 'long';
  else if (cmfBias === 'supply') cmfAgrees = dir === 'short';
  else if (cmfVal != null) cmfAgrees = dir === 'long' ? cmfVal > 0 : cmfVal < 0;
  let mfiAgrees = null;
  if (mfiCur != null) mfiAgrees = dir === 'long' ? mfiCur >= 50 : mfiCur <= 50;
  const checks = [cmfAgrees, mfiAgrees].filter(v => v != null);
  if (checks.length === 0) {
    return feature({ family: 'volume_quality', key: 'cmf_mfi_alignment',
      source: src, mode: 'backfill', missingReason: 'flow_values_unavailable' });
  }
  const disagree = checks.filter(v => v === false).length;
  // riskFlag = volume flow contradicts the trade direction (any disagreement).
  const riskFlag = disagree > 0;
  const normalized = clamp01(disagree / checks.length);
  return feature({ family: 'volume_quality', key: 'cmf_mfi_alignment',
    source: src, mode: 'backfill',
    raw: { direction: dir, cmf: cmfVal, cmfBias, mfiCur, cmfAgrees, mfiAgrees },
    normalized, riskFlag });
}

function forwardVolume(key, source, reason) {
  return feature({ family: 'volume_quality', key, source, mode: 'forward',
    missingReason: reason });
}

// ─── Family 5: category context (all forward-only in v1) ────────────────────

function resolveCat(category) {
  if (CRYPTO_CATS.has(category)) return 'crypto';
  if (US_CATS.has(category)) return 'us';
  if (FX_COMM_CATS.has(category)) return 'fx_comm';
  return 'other';
}

function categoryContextFeatures(signal) {
  const cat = resolveCat(signal?.category);
  return [
    feature({ family: 'category_context', key: 'crypto_market_context',
      source: 'BTC/ETH/BTC.D/funding/OI (external)', mode: 'forward',
      categoryApplicable: cat === 'crypto',
      missingReason: 'external_data_excluded_v1' }),
    feature({ family: 'category_context', key: 'us_equity_context',
      source: 'SPY/QQQ/sector (external)', mode: 'forward',
      categoryApplicable: cat === 'us',
      missingReason: 'external_data_excluded_v1' }),
    feature({ family: 'category_context', key: 'macro_fx_context',
      source: 'DXY/rates (external)', mode: 'forward',
      categoryApplicable: cat === 'fx_comm',
      missingReason: 'external_data_excluded_v1' }),
  ];
}

/**
 * Compute the full shadow-feature set for a signal.
 * @param {object} signal - a graded signal / tracked signal / archive record.
 * @returns {object} versioned shadowFeatures payload (never null).
 */
export function computeShadowFeatures(signal, { now = new Date() } = {}) {
  const features = [];
  // Family 1
  features.push(rsiExtreme(signal));
  features.push(forwardExtension('ema_vwap_distance', 'EMA/VWAP series', 'ohlcv_series_excluded_v1'));
  features.push(forwardExtension('atr_zscore', 'ATR distribution', 'ohlcv_series_excluded_v1'));
  features.push(forwardExtension('volume_climax', 'volume/CDV series', 'ohlcv_series_excluded_v1'));
  // Family 2
  features.push(regimeQuality(signal));
  features.push(forwardVolatility('atr_percentile', 'ATR history', 'ohlcv_series_excluded_v1'));
  features.push(forwardVolatility('bb_width_expansion', 'OHLCV series', 'ohlcv_series_excluded_v1'));
  // Family 3
  features.push(tpPathObstruction(signal));
  features.push(barrierProximity(signal));
  // Family 4
  features.push(cmfMfiAlignment(signal));
  features.push(forwardVolume('volume_zscore', 'volume series', 'ohlcv_series_excluded_v1'));
  features.push(forwardVolume('obv_divergence', 'OBV series', 'ohlcv_series_excluded_v1'));
  // Family 5
  features.push(...categoryContextFeatures(signal));

  return {
    shadowFeaturesVersion: SHADOW_FEATURES_VERSION,
    computedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    features,
  };
}
