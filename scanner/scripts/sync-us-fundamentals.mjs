#!/usr/bin/env node
/**
 * Sync US-equity fundamentals cache from SEC EDGAR (free, no API key).
 *
 * Usage:
 *   SEC_USER_AGENT="Your Name your@email.com" \
 *     node scanner/scripts/sync-us-fundamentals.mjs --symbols AAPL,MSFT
 *   node scanner/scripts/sync-us-fundamentals.mjs --from-watchlist abd_hisse
 *
 * SEC fair-access requires a descriptive User-Agent and <=10 req/sec.
 * Sources used:
 *   - https://www.sec.gov/files/company_tickers.json   (ticker -> CIK)
 *   - https://data.sec.gov/submissions/CIK##########.json
 *   - https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeUsEquityFundamentalCache } from '../lib/fundamental/cache.js';
import { classifyUsEquityFundamentals } from '../lib/fundamental/stance-classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function getUserAgent() {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT env zorunlu (orn: "Ad Soyad mail@example.com")');
  return ua;
}

const MIN_INTERVAL_MS = 120; // ~8 req/sec, safely under SEC 10/sec
let lastCallAt = 0;

async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent': getUserAgent(),
      'Accept-Encoding': 'gzip, deflate',
      'Host': new URL(url).host,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

let TICKER_MAP = null;
async function loadTickerMap() {
  if (TICKER_MAP) return TICKER_MAP;
  const data = await rateLimitedFetch('https://www.sec.gov/files/company_tickers.json');
  TICKER_MAP = new Map();
  for (const k of Object.keys(data)) {
    const row = data[k];
    TICKER_MAP.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
  }
  return TICKER_MAP;
}

function bareTicker(symbol) {
  const s = String(symbol || '');
  return (s.includes(':') ? s.split(':')[1] : s).toUpperCase().trim();
}

// Annual report forms — US domestic (10-K) + foreign private issuers (20-F, 40-F).
// Bug fix (2026-05-15): ARM gibi yabanci issuer'lar 20-F kullaniyor, eski regex
// /10-K/ bunlari eliyordu -> ARM metrics null doneyordu.
const ANNUAL_FORM_RE = /^(10-K|10-K\/A|20-F|20-F\/A|40-F|40-F\/A)$/;
const INTERIM_FORM_RE = /^(10-Q|10-Q\/A|6-K|6-K\/A)$/;

// Pick latest annual (FY) and prior FY values from a XBRL concept payload.
function pickAnnualSeries(concept, units = ['USD', 'USD/shares', 'shares']) {
  if (!concept || !concept.units) return [];
  for (const u of units) {
    const arr = concept.units[u];
    if (!Array.isArray(arr)) continue;
    const fy = arr.filter(x => x.fp === 'FY' && x.form && (ANNUAL_FORM_RE.test(x.form) || /10-K/.test(x.form)));
    if (fy.length === 0) continue;
    // Bug fix (2026-05-15): SEC concept ayni FY icin birden fazla kayit
    // dondurebilir (orijinal 10-K + amendment'lar). Ayrica eski yillarin
    // restated kayitlari karisik gelebilir -> rev[0]/rev[1] ardisik olmayan
    // 2025 ve 2008 yillarini birlestirip HON-da %284 gibi sahte YoY uretiyordu.
    // Cozum: end tarihine gore DESC sirala, fiscal yil bazli dedup et (her FY
    // icin en son filed olani sakla).
    const sorted = fy.slice().sort((a, b) => {
      const dEnd = new Date(b.end) - new Date(a.end);
      if (dEnd !== 0) return dEnd;
      // Ayni end -> en son filed (filed alanindan) onde
      return new Date(b.filed || 0) - new Date(a.filed || 0);
    });
    const seenFy = new Set();
    const deduped = [];
    for (const row of sorted) {
      const fyKey = row.fy ?? String(row.end || '').slice(0, 4);
      if (seenFy.has(fyKey)) continue;
      seenFy.add(fyKey);
      deduped.push(row);
    }
    return deduped;
  }
  return [];
}

function pickLatestQuarterly(concept, units = ['USD', 'USD/shares']) {
  if (!concept || !concept.units) return [];
  for (const u of units) {
    const arr = concept.units[u];
    if (!Array.isArray(arr)) continue;
    // Bug fix: 20-F/6-K/40-F formlarini da kapsa
    const q = arr.filter(x => x.form && (INTERIM_FORM_RE.test(x.form) || ANNUAL_FORM_RE.test(x.form) || /10-Q|10-K/.test(x.form)));
    if (q.length > 0) return q.sort((a, b) => new Date(b.end) - new Date(a.end));
  }
  return [];
}

// -----------------------------------------------------------------------------
// TTM (Trailing 12 Months) — Bug fix (2026-05-15)
// Eski sistem yalniz 10-K (FY) revenue/NI degerini kullaniyordu; PG gibi
// non-calendar fiscal yili olan sirketler icin gerilim YIL eski (PG: 2025-06-30,
// 320 gun once). Olusum yontemi:
//   - Concept entry'lerinden period uzunlugu hesapla (end - start)
//   - ~90 gun (75-105) olanlar quarterly periyodik gelir/net income
//   - End tarihinden geriye dogru 4 ardisik (non-overlapping) period topla
//   - Bu TTM degeri yillik 10-K'dan daha taze gerceklesen 12 ayi yansitir
// Notu: cumulative interim (3M/6M/9M) raporlanan sirketler icin de bu
// algoritma calisir, cunku biz period_days~90 olan QUARTERLY (discrete)
// kayitlari ariyoruz. Sirket sadece kumulatif veriyorsa farkini hesapla
// (gelistirilebilir; suanda quarterly-only yeterli kapsama veriyor).
// -----------------------------------------------------------------------------
function periodDays(rec) {
  if (!rec?.start || !rec?.end) return null;
  const d = (new Date(rec.end) - new Date(rec.start)) / 86400000 + 1;
  return Math.round(d);
}

function pickQuarterlyDiscrete(concept, units = ['USD', 'USD/shares']) {
  if (!concept || !concept.units) return [];
  for (const u of units) {
    const arr = concept.units[u];
    if (!Array.isArray(arr)) continue;
    // Yalnizca quarterly (~90 gun) ve interim form'larda olanlari al
    const q = arr.filter(x => {
      if (!x.form) return false;
      if (!(INTERIM_FORM_RE.test(x.form) || /10-Q/.test(x.form))) return false;
      const days = periodDays(x);
      return days != null && days >= 75 && days <= 105;
    });
    if (q.length > 0) return q.sort((a, b) => new Date(b.end) - new Date(a.end));
  }
  return [];
}

function computeTTM(facts, conceptNames, units = ['USD']) {
  // YOL 1: 4 ardisik discrete quarter (Apple, MSFT gibi seffaf raporlayanlar).
  let bestDiscrete = [];
  for (const n of conceptNames) {
    const c = firstConcept(facts, [n]);
    const q = pickQuarterlyDiscrete(c, units);
    if (q.length === 0) continue;
    if (bestDiscrete.length === 0 || new Date(q[0].end) > new Date(bestDiscrete[0].end)) {
      bestDiscrete = q;
    }
  }
  if (bestDiscrete.length >= 4) {
    const ttmEntries = [];
    let cursorEnd = null;
    for (const row of bestDiscrete) {
      if (ttmEntries.length === 0) {
        ttmEntries.push(row);
        cursorEnd = new Date(row.start);
        continue;
      }
      const rowEnd = new Date(row.end);
      if (rowEnd >= cursorEnd) continue;
      const gap = (cursorEnd - rowEnd) / 86400000;
      if (gap > 15) break;
      ttmEntries.push(row);
      cursorEnd = new Date(row.start);
      if (ttmEntries.length === 4) break;
    }
    if (ttmEntries.length === 4) {
      const sum = ttmEntries.reduce((s, r) => s + (Number(r.val) || 0), 0);
      return { value: sum, ok: true, method: '4Q_discrete', end: ttmEntries[0].end, start: ttmEntries[3].start };
    }
  }

  // YOL 2: YTD-bazli TTM hesabi (PG, COST gibi non-calendar fiscal yili
  // olan, Q4 ayri raporlamayan sirketler icin).
  //   TTM = YTD_now + FY_prev - YTD_prev_sameLength
  // Ornek: PG fiscal Jul-Jun. Mart 2026 sonu itibariyle:
  //   YTD_now = 9M (Jul2025-Mar2026) = 65.83B
  //   FY_prev = FY2025 (Jul2024-Jun2025) = 84.28B
  //   YTD_prev = 9M (Jul2024-Mar2025) = 63.40B
  //   TTM = 65.83 + 84.28 - 63.40 = 86.71B (Apr2025-Mar2026)
  // Tum entry'leri (discrete dahil olmamak uzere) topla, en taze YTD'yi bul.
  let allEntries = [];
  for (const n of conceptNames) {
    const c = firstConcept(facts, [n]);
    if (!c?.units) continue;
    for (const u of units) {
      const arr = c.units[u];
      if (Array.isArray(arr)) {
        for (const row of arr) {
          if (!row.form) continue;
          if (!(INTERIM_FORM_RE.test(row.form) || ANNUAL_FORM_RE.test(row.form) || /10-K|10-Q/.test(row.form))) continue;
          const days = periodDays(row);
          if (days == null) continue;
          allEntries.push({ ...row, _days: days });
        }
      }
    }
  }
  if (allEntries.length === 0) return { value: null, ok: false, end: null };

  // En taze YTD: days >= 150 ve days < 365 (3-month value disinda kalan, FY de degil)
  // ya da > 365 olabilir mi (fiscal yil 53 hafta) - hayir 365+ FY say.
  const ytdCandidates = allEntries.filter(e => e._days >= 150 && e._days <= 320);
  ytdCandidates.sort((a, b) => new Date(b.end) - new Date(a.end));
  const ytdNow = ytdCandidates[0];
  if (!ytdNow) return { value: null, ok: false, end: null };

  // FY_prev: 350-380 gun annual entry, end >= (ytdNow.start - 30g)
  // FY_prev.end ytdNow.start'in hemen oncesi olmali
  const fyEntries = allEntries.filter(e => e._days >= 350 && e._days <= 380);
  fyEntries.sort((a, b) => new Date(b.end) - new Date(a.end));
  // ytdNow.start'tan bir gun once bitmesi gereken FY
  const ytdNowStart = new Date(ytdNow.start);
  const fyPrev = fyEntries.find(e => {
    const dEnd = new Date(e.end);
    const diff = (ytdNowStart - dEnd) / 86400000;
    return diff >= -1 && diff <= 5; // FY_prev.end = ytdNow.start - 1 (kabaca)
  });
  if (!fyPrev) return { value: null, ok: false, end: ytdNow.end };

  // YTD_prev: aynı uzunluk, fyPrev'in start'inden başlayan
  const fyPrevStart = new Date(fyPrev.start);
  const ytdPrev = ytdCandidates.find(e => {
    if (Math.abs(e._days - ytdNow._days) > 7) return false;
    const dStart = new Date(e.start);
    const diff = Math.abs((dStart - fyPrevStart) / 86400000);
    return diff <= 5;
  });
  if (!ytdPrev) return { value: null, ok: false, end: ytdNow.end };

  const ttm = Number(ytdNow.val) + Number(fyPrev.val) - Number(ytdPrev.val);
  if (!Number.isFinite(ttm)) return { value: null, ok: false, end: ytdNow.end };

  return {
    value: ttm,
    ok: true,
    method: 'YTD_synthesis',
    end: ytdNow.end,
    start: new Date(new Date(ytdNow.end).getTime() - 365 * 86400000).toISOString().slice(0, 10),
    breakdown: { ytdNow: ytdNow.val, fyPrev: fyPrev.val, ytdPrev: ytdPrev.val },
  };
}

function firstConcept(facts, names) {
  const usGaap = facts?.facts?.['us-gaap'];
  if (!usGaap) return null;
  for (const n of names) if (usGaap[n]) return usGaap[n];
  return null;
}

// Bug fix (2026-05-15): SEC'in zaman icinde concept adlarini degistirmesi
// (Revenues -> SalesRevenueNet -> RevenueFromContractWithCustomerExcludingAssessedTax)
// HON, AVGO gibi sirketlerde firstConcept eski concept'i secip eski tarihli
// (2011, 2018) veri donduruyordu. Bu fonksiyon TUM aday concept'leri tarar,
// en taze FY end date'ini icereni secer. Boylece HON 2024+ verisi
// RevenueFromContractWith... altinda olsa bile dogru cekilir.
function latestAnnualFromConcepts(facts, names, units = ['USD', 'USD/shares', 'shares']) {
  const candidates = [];
  for (const n of names) {
    const series = pickAnnualSeries(firstConcept(facts, [n]), units);
    if (series.length > 0) {
      candidates.push({ concept: n, series, latestEnd: new Date(series[0].end).getTime() });
    }
  }
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.latestEnd - a.latestEnd);
  return candidates[0].series;
}

function latestQuarterlyFromConcepts(facts, names, units = ['USD', 'USD/shares']) {
  const candidates = [];
  for (const n of names) {
    const series = pickLatestQuarterly(firstConcept(facts, [n]), units);
    if (series.length > 0) {
      candidates.push({ concept: n, series, latestEnd: new Date(series[0].end).getTime() });
    }
  }
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.latestEnd - a.latestEnd);
  return candidates[0].series;
}

function safeDiv(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

// Bug fix (2026-05-15): YoY hesaplamak icin iki kaydin ardisik yillar olduguna
// emin ol. Aksi halde 2025 vs 2008 gibi karisikliklar +%284 sahte buyume verir.
// rev0.end ve rev1.end arasi 365 ± 60 gun olmali (esnek: 13 ay fiscal calendar
// drift'i icin).
function isConsecutiveAnnual(rec0, rec1) {
  if (!rec0?.end || !rec1?.end) return false;
  const d0 = new Date(rec0.end).getTime();
  const d1 = new Date(rec1.end).getTime();
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) return false;
  const diffDays = (d0 - d1) / 86400000;
  return diffDays >= 305 && diffDays <= 425; // 10-14 ay araligi
}

function yoyFromSeries(series) {
  if (!Array.isArray(series) || series.length < 2) return { v0: null, v1: null, ok: false };
  const r0 = series[0];
  // r0'a en yakin ardisik onceki kaydi bul (1'den sonra 2,3,... taranabilir
  // cunku bazen restated kayitlar dedup'tan kacabilir)
  for (let i = 1; i < series.length; i++) {
    if (isConsecutiveAnnual(r0, series[i])) {
      return { v0: r0.val, v1: series[i].val, ok: true, end0: r0.end, end1: series[i].end };
    }
  }
  return { v0: r0.val, v1: null, ok: false, end0: r0.end };
}

function normalizeMetrics(facts) {
  // Bug fix (2026-05-15): firstConcept yerine latestAnnualFromConcepts kullan —
  // SEC concept-name degisikliklerinde en taze veriyi otomatik secer
  // (HON 2011 -> 2024, AVGO 2018 -> 2024 fiscalPeriod fix).
  const revFY = latestAnnualFromConcepts(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
  const niFY = latestAnnualFromConcepts(facts, ['NetIncomeLoss']);
  const epsFY = latestAnnualFromConcepts(facts, ['EarningsPerShareDiluted'], ['USD/shares']);
  const grossFY = latestAnnualFromConcepts(facts, ['GrossProfit']);
  const opFY = latestAnnualFromConcepts(facts, ['OperatingIncomeLoss']);
  const ocfFY = latestAnnualFromConcepts(facts, ['NetCashProvidedByUsedInOperatingActivities']);
  const capexFY = latestAnnualFromConcepts(facts, ['PaymentsToAcquirePropertyPlantAndEquipment']);

  // Bug fix (2026-05-15): TTM — kullanici "en guncel veri" istedi. 10-K annual
  // PG icin 320 gun once kalabiliyor; TTM en son 4 quarter sum'i ile 30-90 gun
  // taze veri verir. revenue/netIncome/grossProfit/opIncome/ocf/capex icin TTM
  // hesapla, eger 4 ardisik quarter varsa annual yerine TTM'i kullan.
  const revTTM = computeTTM(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
  const niTTM = computeTTM(facts, ['NetIncomeLoss']);
  const grossTTM = computeTTM(facts, ['GrossProfit']);
  const opTTM = computeTTM(facts, ['OperatingIncomeLoss']);
  const ocfTTM = computeTTM(facts, ['NetCashProvidedByUsedInOperatingActivities']);
  const capexTTM = computeTTM(facts, ['PaymentsToAcquirePropertyPlantAndEquipment']);

  const assetsQ = latestQuarterlyFromConcepts(facts, ['Assets']);
  const liabsQ = latestQuarterlyFromConcepts(facts, ['Liabilities']);
  const equityQ = latestQuarterlyFromConcepts(facts, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
  const caQ = latestQuarterlyFromConcepts(facts, ['AssetsCurrent']);
  const clQ = latestQuarterlyFromConcepts(facts, ['LiabilitiesCurrent']);

  // YoY hesabi icin ardisik yil kontrolu (Bug fix 2026-05-15)
  // TTM aktifse: YoY = (TTM_now - FY_prev) / FY_prev (en taze veri)
  // TTM yoksa: klasik FY[0] vs FY[1] YoY (yoyFromSeries — ardisik yil kontrolu)
  const revYoYFY = yoyFromSeries(revFY);
  const epsYoYFY = yoyFromSeries(epsFY);
  // revenueGrowthYoY: GERCEK yil-uzeri-yil buyume — son tam FY vs onceki FY.
  // (Onceden TTM aktifken (TTM - son_FY)/son_FY hesaplanip "YoY" deniyordu;
  //  bu kismi-donem buyumesidir, gercek YoY degil — alan adi yanitiyordu.)
  const revenueGrowthYoY = revYoYFY.ok ? safeDiv(revYoYFY.v0 - revYoYFY.v1, revYoYFY.v1) : null;
  // revenueGrowthTtmVsFy: TTM toplaminin son tam FY'ye gore buyumesi. Gercek
  // YoY DEGILDIR; TTM ~3-12 ay daha taze veri tasidigindan freshness/ivme
  // gostergesi olarak ayri tutulur.
  let revenueGrowthTtmVsFy = null;
  if (revTTM.ok && Number.isFinite(revFY[0]?.val) && revFY[0].val > 0) {
    revenueGrowthTtmVsFy = (revTTM.value - revFY[0].val) / revFY[0].val;
  }
  const epsGrowthYoY = (epsYoYFY.ok && Number.isFinite(epsYoYFY.v0) && Number.isFinite(epsYoYFY.v1) && epsYoYFY.v1 !== 0)
    ? (epsYoYFY.v0 - epsYoYFY.v1) / Math.abs(epsYoYFY.v1) : null;

  // TTM oncelik: en yeni veri varsa TTM, yoksa FY[0] kullan
  const rev0 = revTTM.ok ? revTTM.value : revFY[0]?.val;
  const ni0 = niTTM.ok ? niTTM.value : niFY[0]?.val;
  const gross0 = grossTTM.ok ? grossTTM.value : grossFY[0]?.val;
  const op0 = opTTM.ok ? opTTM.value : opFY[0]?.val;
  const ocf0 = ocfTTM.ok ? ocfTTM.value : ocfFY[0]?.val;
  const capex0 = capexTTM.ok ? capexTTM.value : capexFY[0]?.val;
  const equity0 = equityQ[0]?.val;
  const assets0 = assetsQ[0]?.val;
  const liabs0 = liabsQ[0]?.val;
  const ca0 = caQ[0]?.val;
  const cl0 = clQ[0]?.val;

  const fcf = (Number.isFinite(ocf0) && Number.isFinite(capex0)) ? ocf0 - capex0 : null;
  // En taze veri ucu (debug + freshness icin)
  const mostRecentDataEnd = [
    revTTM.end, niTTM.end, assetsQ[0]?.end, equityQ[0]?.end,
    revFY[0]?.end, niFY[0]?.end,
  ].filter(Boolean).sort().pop() || null;

  return {
    revenueGrowthYoY,
    revenueGrowthTtmVsFy,
    epsGrowthYoY,
    grossMargin: safeDiv(gross0, rev0),
    operatingMargin: safeDiv(op0, rev0),
    netMargin: safeDiv(ni0, rev0),
    roe: safeDiv(ni0, equity0),
    debtToEquity: safeDiv(liabs0, equity0),
    currentRatio: safeDiv(ca0, cl0),
    freeCashFlow: fcf,
    freeCashFlowMargin: safeDiv(fcf, rev0),
    pe: null,
    forwardPe: null,
    evToEbitda: null,
    earningsDate: null,
    // Veri kaynagi seffafligi — kullanici Annual mi TTM mi gordugunu anlasin
    _ttm: {
      revenue: revTTM.ok ? { value: revTTM.value, end: revTTM.end, start: revTTM.start } : null,
      netIncome: niTTM.ok ? { value: niTTM.value, end: niTTM.end, start: niTTM.start } : null,
      grossProfit: grossTTM.ok ? { value: grossTTM.value, end: grossTTM.end } : null,
      operatingIncome: opTTM.ok ? { value: opTTM.value, end: opTTM.end } : null,
      ocf: ocfTTM.ok ? { value: ocfTTM.value, end: ocfTTM.end } : null,
      capex: capexTTM.ok ? { value: capexTTM.value, end: capexTTM.end } : null,
      usedTTM: revTTM.ok, // ana gelir TTM kullanildi mi?
    },
    _meta: {
      latestFiscalYearEnd: revFY[0]?.end || null,
      latestQuarterEnd: assetsQ[0]?.end || null,
      mostRecentDataEnd: mostRecentDataEnd, // en taze rapor edilen donem (10-K veya 10-Q veya TTM)
      incomeStatementSource: revTTM.ok ? 'TTM' : 'FY',
      incomeStatementEnd: revTTM.ok ? revTTM.end : revFY[0]?.end || null,
    },
  };
}

async function buildPayloadForSymbol(ticker) {
  const map = await loadTickerMap();
  const cik = map.get(ticker);
  if (!cik) {
    return {
      schemaVersion: 1,
      symbol: ticker,
      category: 'abd_hisse',
      source: { financials: 'sec_edgar_companyfacts' },
      asOf: null,
      fiscalPeriod: null,
      freshness: 'missing',
      metrics: null,
      classification: classifyUsEquityFundamentals(null),
      raw: { lastUpdatedBySync: new Date().toISOString(), error: 'cik_not_found' },
    };
  }
  let facts;
  try {
    facts = await rateLimitedFetch(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`
    );
  } catch (err) {
    // Bug fix (2026-05-15): 404 vs (DXYZ gibi yeni IPO sirketleri SEC'de
    // companyfacts endpoint'inde olmayabilir). Cache'e hata payload yaz ki
    // her gun ayni 404'u yememeye calismayalim.
    if (/HTTP 404/.test(err.message || '')) {
      return {
        schemaVersion: 1,
        symbol: ticker,
        category: 'abd_hisse',
        source: { financials: 'sec_edgar_companyfacts' },
        asOf: null,
        fiscalPeriod: null,
        freshness: 'missing',
        metrics: null,
        classification: classifyUsEquityFundamentals(null),
        raw: { lastUpdatedBySync: new Date().toISOString(), cik, error: 'no_companyfacts_404' },
      };
    }
    throw err;
  }
  const metrics = normalizeMetrics(facts);
  const ttm = metrics._ttm || {};
  const meta = metrics._meta || {};
  delete metrics._ttm;
  delete metrics._meta;
  // asOf: en taze veri ucu (TTM veya quarterly veya annual). Onceden sadece
  // latestQuarterEnd kullaniyordu; TTM destegiyle income statement ucu da olabilir.
  const asOf = meta.mostRecentDataEnd || meta.latestQuarterEnd || meta.latestFiscalYearEnd || null;

  const cache = {
    schemaVersion: 1,
    symbol: ticker,
    category: 'abd_hisse',
    source: { financials: 'sec_edgar_companyfacts' },
    asOf: asOf ? new Date(asOf).toISOString() : new Date().toISOString(),
    fiscalPeriod: meta.latestFiscalYearEnd || null,
    incomeStatementSource: meta.incomeStatementSource || 'FY', // 'TTM' veya 'FY'
    incomeStatementEnd: meta.incomeStatementEnd || null,
    freshness: 'fresh',
    metrics,
    ttm, // kullanici denetimi icin saklanir (cache.ttm.usedTTM bool)
    raw: { lastUpdatedBySync: new Date().toISOString(), cik },
  };
  cache.classification = classifyUsEquityFundamentals(cache);
  return cache;
}

function parseArgs(argv) {
  const out = { symbols: [], fromWatchlist: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--symbols') out.symbols = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--from-watchlist') out.fromWatchlist = argv[++i];
    else if (!a.startsWith('--')) out.symbols.push(a);
  }
  return out;
}

function loadWatchlist(category) {
  const rulesPath = path.join(PROJECT_ROOT, 'rules.json');
  const fallback = path.join(PROJECT_ROOT, 'scanner', 'rules.json');
  const file = fs.existsSync(rulesPath) ? rulesPath : fallback;
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = rules?.watchlist?.[category] || [];
  return list.map(bareTicker);
}

/**
 * Programmatic entry — used by scheduler daily job.
 * @returns {Promise<{ok:number, fail:number, skipped:number, symbols:string[]}>}
 */
export async function syncUsFundamentals({ symbols = [], fromWatchlist = null, logger = console } = {}) {
  let list = symbols.map(bareTicker);
  if (fromWatchlist) list = [...list, ...loadWatchlist(fromWatchlist)];
  list = [...new Set(list)].filter(Boolean);
  let ok = 0, fail = 0;
  for (const sym of list) {
    try {
      const payload = await buildPayloadForSymbol(sym);
      writeUsEquityFundamentalCache(sym, payload);
      logger.log?.(`[fundamental-sync] ${sym} ok (overall=${payload.classification?.overall || 'unknown'})`);
      ok++;
    } catch (err) {
      logger.error?.(`[fundamental-sync] ${sym} FAILED: ${err.message}`);
      fail++;
    }
  }
  return { ok, fail, skipped: 0, symbols: list };
}

async function main() {
  // Trigger early validation when run as CLI.
  getUserAgent();
  const args = parseArgs(process.argv.slice(2));
  let symbols = args.symbols.map(bareTicker);
  if (args.fromWatchlist) symbols = [...symbols, ...loadWatchlist(args.fromWatchlist)];
  symbols = [...new Set(symbols)].filter(Boolean);

  if (symbols.length === 0) {
    console.error('Usage: node scanner/scripts/sync-us-fundamentals.mjs --symbols AAPL,MSFT');
    console.error('   or: node scanner/scripts/sync-us-fundamentals.mjs --from-watchlist abd_hisse');
    process.exit(1);
  }

  let ok = 0, fail = 0;
  for (const sym of symbols) {
    try {
      const payload = await buildPayloadForSymbol(sym);
      const file = writeUsEquityFundamentalCache(sym, payload);
      console.log(`[fundamental-sync] ${sym} -> ${path.relative(PROJECT_ROOT, file)} (overall=${payload.classification?.overall || 'unknown'})`);
      ok++;
    } catch (err) {
      console.error(`[fundamental-sync] ${sym} FAILED: ${err.message}`);
      fail++;
    }
  }
  console.log(`[fundamental-sync] done: ${ok} ok, ${fail} fail`);
}

// Run as CLI only when invoked directly (not when imported).
const invokedAsCli = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch { return false; }
})();
if (invokedAsCli) {
  main().catch(err => { console.error(err); process.exit(1); });
}
