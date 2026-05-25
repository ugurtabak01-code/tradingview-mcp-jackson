/**
 * Public entry — build a fundamentalSnapshot for a signal.
 * Returns null for non-US-equity categories (no impact on technical flow).
 */

import { readUsEquityFundamentalCache } from './cache.js';
import { classifyUsEquityFundamentals } from './stance-classifier.js';

function isUsEquityCategory(category) {
  return category === 'abd_hisse';
}

export function buildFundamentalSnapshot({ symbol, category, now = new Date() } = {}) {
  if (!isUsEquityCategory(category)) return null;

  const cache = readUsEquityFundamentalCache(symbol);

  // Bug fix (2026-05-15): summary'leri HER ZAMAN canli hesapla.
  // Eski kod cache.classification.sections varsa onu donduruyordu -> stance-classifier
  // gunes yapildiktan sonra bile eski generic summary'ler ("Gelir ve EPS yillik
  // buyume egilimi.") gidiyordu. Cache yalnizca metrics + asOf saklasin; ozet
  // ve overall her cagrida classifyUsEquityFundamentals'tan turetilsin.
  const classified = classifyUsEquityFundamentals(cache, now);

  return {
    category: 'abd_hisse',
    symbol,
    source: cache?.source || null,
    overall: classified.overall,
    freshness: classified.freshness,
    asOf: classified.asOf,
    fiscalPeriod: classified.fiscalPeriod,
    sections: classified.sections,
    metrics: cache?.metrics || null,
  };
}

export { readUsEquityFundamentalCache, writeUsEquityFundamentalCache, listCachedUsEquitySymbols } from './cache.js';
export { classifyUsEquityFundamentals } from './stance-classifier.js';
