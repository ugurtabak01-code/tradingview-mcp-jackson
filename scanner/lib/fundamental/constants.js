/**
 * Fundamental analysis constants — US equities only (initial scope).
 */

export const FUNDAMENTAL_STANCES = new Set(['positive', 'neutral', 'negative', 'unknown']);

export const FRESHNESS = {
  FRESH: 'fresh',
  STALE: 'stale',
  MISSING: 'missing',
};

export const US_EQUITY_CACHE_MAX_AGE_DAYS = 120; // SEC quarterly data cadence
export const EARNINGS_EVENT_WINDOW_DAYS = 3;

export const STANCE_LABELS = {
  positive: 'Pozitif',
  neutral: 'Notr',
  negative: 'Negatif',
  unknown: 'Bilinmiyor',
};

export const SECTION_LABELS = {
  growth: 'Buyume',
  profitability: 'Karlilik',
  balance_sheet: 'Bilanco Saglamligi',
  cash_flow: 'Nakit Akimi',
  valuation: 'Degerleme',
  event_risk: 'Olay Riski',
  data_quality: 'Veri Kalitesi',
};
