/**
 * Classify normalized US-equity fundamental metrics into stances.
 * Pure function: no I/O, deterministic.
 */

import { EARNINGS_EVENT_WINDOW_DAYS, US_EQUITY_CACHE_MAX_AGE_DAYS, SECTION_LABELS } from './constants.js';

function stanceFromScore(score) {
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= 1) return 'positive';
  if (score <= -1) return 'negative';
  return 'neutral';
}

function daysBetween(a, b) {
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.round((y - x) / 86400000);
}

function num(v) {
  return Number.isFinite(v) ? v : null;
}

function score(value, posThreshold, negThreshold) {
  if (value == null) return { score: 0, known: false };
  if (value > posThreshold) return { score: 1, known: true };
  if (value < negThreshold) return { score: -1, known: true };
  return { score: 0, known: true };
}

function aggregate(parts) {
  const known = parts.filter(p => p.known);
  if (known.length === 0) return { stance: 'unknown', total: 0 };
  const total = known.reduce((s, p) => s + p.score, 0);
  return { stance: stanceFromScore(total), total };
}

// -----------------------------------------------------------------------------
// Concrete-number formatters (2026-05-15 bug fix)
// Eski kod sections[].summary alanlarini generic etiketlerle dolduruyordu
// ("Gelir ve EPS yillik buyume egilimi.") — kart "Pozitif" diyordu ama hangi
// rakamlardan oturu pozitif belli olmuyordu. Asagidaki yardimcilar metrics
// objesindeki gercek sayilari formatlayip summary'ye yaziyor.
// -----------------------------------------------------------------------------
function pct(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  return (value * 100).toFixed(digits) + '%';
}
function ratio(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return value.toFixed(digits);
}
function bigUSD(value) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1e12) return (value / 1e12).toFixed(2) + 'T$';
  if (abs >= 1e9) return (value / 1e9).toFixed(2) + 'B$';
  if (abs >= 1e6) return (value / 1e6).toFixed(2) + 'M$';
  return value.toFixed(0) + '$';
}
function joinParts(parts) {
  const filtered = parts.filter(Boolean);
  return filtered.length ? filtered.join(' · ') : null;
}

export function classifyUsEquityFundamentals(cache, now = new Date()) {
  if (!cache || !cache.metrics) {
    return {
      overall: 'unknown',
      freshness: 'missing',
      asOf: cache?.asOf || null,
      fiscalPeriod: cache?.fiscalPeriod || null,
      sections: [{
        key: 'data_quality',
        label: SECTION_LABELS.data_quality,
        stance: 'unknown',
        summary: 'Temel analiz cache verisi bulunamadi.',
      }],
    };
  }

  const m = cache.metrics;
  const ageDays = cache.asOf ? daysBetween(cache.asOf, now) : null;
  const freshness = ageDays == null ? 'missing'
    : ageDays > US_EQUITY_CACHE_MAX_AGE_DAYS ? 'stale'
    : 'fresh';

  const growthParts = [
    score(num(m.revenueGrowthYoY), 0.05, -0.03),
    score(num(m.epsGrowthYoY), 0.05, -0.05),
  ];
  const profitParts = [
    score(num(m.grossMargin), 0.35, 0.15),
    score(num(m.operatingMargin), 0.15, 0.03),
    score(num(m.roe), 0.12, 0.03),
  ];
  const balanceParts = [];
  if (num(m.currentRatio) != null) balanceParts.push({ score: m.currentRatio >= 1 ? 1 : -1, known: true });
  if (num(m.debtToEquity) != null) {
    balanceParts.push({
      score: m.debtToEquity <= 1.5 ? 1 : m.debtToEquity > 3 ? -1 : 0,
      known: true,
    });
  }
  const cashParts = [];
  if (num(m.freeCashFlow) != null) cashParts.push({ score: m.freeCashFlow > 0 ? 1 : -1, known: true });
  if (num(m.freeCashFlowMargin) != null) cashParts.push(score(num(m.freeCashFlowMargin), 0.05, 0));

  const valuationParts = [];
  if (num(m.forwardPe) != null && num(m.pe) != null) {
    valuationParts.push({ score: m.forwardPe < m.pe ? 1 : 0, known: true });
  }
  if (num(m.pe) != null) {
    valuationParts.push({
      score: m.pe > 45 ? -1 : m.pe < 18 ? 1 : 0,
      known: true,
    });
  }
  if (num(m.evToEbitda) != null) {
    valuationParts.push({ score: m.evToEbitda > 25 ? -1 : 0, known: true });
  }

  const eventParts = [];
  if (m.earningsDate) {
    const d = daysBetween(now, m.earningsDate);
    if (d != null) {
      eventParts.push({
        score: Math.abs(d) <= EARNINGS_EVENT_WINDOW_DAYS ? -1 : 0,
        known: true,
      });
    }
  }

  const dataQualityScore = freshness === 'fresh' ? 1 : freshness === 'stale' ? -1 : 0;

  const growth = aggregate(growthParts);
  const profit = aggregate(profitParts);
  const balance = aggregate(balanceParts);
  const cash = aggregate(cashParts);
  const valuation = aggregate(valuationParts);
  const event = aggregate(eventParts);

  // ---- Somut sayilarla zenginlestirilmis summary'ler ----
  // Generic etiketler yerine gercek metric degerlerini cikartiyoruz; veri yoksa
  // 'n/a' ile geciyor, geriye fallback generic etiket kaliyor.
  // Bug fix (2026-05-15): kullaniciya ozetin hangi donemden geldigini gostersin
  // (TTM = trailing 12 months, FY = annual 10-K). Cache'de incomeStatementSource
  // ve incomeStatementEnd alanlari var.
  const isSrc = cache.incomeStatementSource || (cache.ttm?.usedTTM ? 'TTM' : 'FY');
  const isEnd = cache.incomeStatementEnd ? String(cache.incomeStatementEnd).slice(0, 10) : null;
  const isLabel = isEnd ? `${isSrc}-${isEnd}` : isSrc;
  const growthSummary = joinParts([
    pct(m.revenueGrowthYoY) != null ? `Gelir YoY ${pct(m.revenueGrowthYoY)}` : null,
    pct(m.epsGrowthYoY) != null ? `EPS YoY ${pct(m.epsGrowthYoY)}` : null,
    `[${isLabel}]`,
  ]) || 'Gelir/EPS verisi yok';

  const profitSummary = joinParts([
    pct(m.grossMargin) != null ? `Brut M %${(m.grossMargin * 100).toFixed(1)}` : null,
    pct(m.operatingMargin) != null ? `Op M %${(m.operatingMargin * 100).toFixed(1)}` : null,
    pct(m.netMargin) != null ? `Net M %${(m.netMargin * 100).toFixed(1)}` : null,
    pct(m.roe) != null ? `ROE %${(m.roe * 100).toFixed(1)}` : null,
  ]) || 'Karlilik verisi yok';

  const balanceSummary = joinParts([
    ratio(m.currentRatio) != null ? `Cari oran ${ratio(m.currentRatio)}` : null,
    ratio(m.debtToEquity) != null ? `D/E ${ratio(m.debtToEquity)}` : null,
  ]) || 'Bilanco verisi yok';

  const cashSummary = joinParts([
    bigUSD(m.freeCashFlow) != null ? `FCF ${bigUSD(m.freeCashFlow)}` : null,
    pct(m.freeCashFlowMargin) != null ? `FCF M %${(m.freeCashFlowMargin * 100).toFixed(1)}` : null,
  ]) || 'Nakit akimi verisi yok';

  const valuationSummary = joinParts([
    ratio(m.pe) != null ? `P/E ${ratio(m.pe, 1)}` : null,
    ratio(m.forwardPe) != null ? `Forward P/E ${ratio(m.forwardPe, 1)}` : null,
    ratio(m.evToEbitda) != null ? `EV/EBITDA ${ratio(m.evToEbitda, 1)}` : null,
  ]) || 'Carpan verisi yok (SEC EDGAR P/E vermez)';

  let eventSummary = 'Bilanco tarihi bilinmiyor';
  if (m.earningsDate) {
    const d = daysBetween(now, m.earningsDate);
    if (d != null) {
      const within = Math.abs(d) <= EARNINGS_EVENT_WINDOW_DAYS;
      const when = d >= 0 ? `${d}g sonra` : `${Math.abs(d)}g once`;
      eventSummary = within
        ? `UYARI: Bilanco penceresi (${when}, ±${EARNINGS_EVENT_WINDOW_DAYS}g icinde)`
        : `Bilanco ${when} — pencere disinda`;
    }
  }

  const dqDetail = ageDays != null ? ` (${ageDays}g once, asOf: ${String(cache.asOf || '?').slice(0, 10)})` : '';
  const sections = [
    { key: 'growth', label: SECTION_LABELS.growth, stance: growth.stance, summary: growthSummary },
    { key: 'profitability', label: SECTION_LABELS.profitability, stance: profit.stance, summary: profitSummary },
    { key: 'balance_sheet', label: SECTION_LABELS.balance_sheet, stance: balance.stance, summary: balanceSummary },
    { key: 'cash_flow', label: SECTION_LABELS.cash_flow, stance: cash.stance, summary: cashSummary },
    { key: 'valuation', label: SECTION_LABELS.valuation, stance: valuation.stance, summary: valuationSummary },
    { key: 'event_risk', label: SECTION_LABELS.event_risk, stance: event.stance, summary: eventSummary },
    { key: 'data_quality', label: SECTION_LABELS.data_quality, stance: stanceFromScore(dataQualityScore),
      summary: `Veri tazeligi: ${freshness}${dqDetail}` },
  ];

  // Overall: signal-relevant sections only (exclude data_quality + event_risk noise)
  const signalSections = [growth, profit, balance, cash, valuation];
  const knownSignal = signalSections.filter(s => s.stance !== 'unknown');
  let overall = 'unknown';
  if (knownSignal.length > 0) {
    const total = knownSignal.reduce((sum, s) =>
      sum + (s.stance === 'positive' ? 1 : s.stance === 'negative' ? -1 : 0), 0);
    overall = stanceFromScore(total);
  }

  return {
    overall,
    freshness,
    asOf: cache.asOf || null,
    fiscalPeriod: cache.fiscalPeriod || null,
    sections,
  };
}
