import { findSwingPoints } from './formation-detector.js';

// Scanner OHLCV her TF icin SABIT 100 bar cekiyor (getOhlcvValidated(100, ...)).
// Bu yuzden pencereler 100 bara gore kalibre.
const MAX_BARS = 100;
const WINDOW_RULES = {
  bist:        { '240': [50, 100], '1D': [50, 100], '1W': [40, 90] },
  crypto:      { '240': [60, 100], '1D': [50, 100], '1W': [40, 90] },
  forex:       { '240': [50, 100], '1D': [50, 100], '1W': [40, 90] },
  commodities: { '240': [50, 100], '1D': [50, 100], '1W': [40, 90] },
  us_equity:   { '240': [50, 100], '1D': [50, 100], '1W': [40, 90] },
  default:     { '240': [50, 100], '1D': [50, 100], '1W': [40, 90] },
};

function normalizeTimeframe(tf) {
  const s = String(tf || '').toUpperCase();
  if (s === '240' || s === '4H' || s === 'H4') return '240';
  if (s === '1D' || s === 'D') return '1D';
  if (s === '1W' || s === 'W') return '1W';
  return s;
}

function normalizeMarketType(marketType, symbol) {
  const s = String(marketType || '').toLowerCase();
  if (['crypto', 'kripto'].includes(s)) return 'crypto';
  if (['bist', 'turkish_equity'].includes(s)) return 'bist';
  if (['forex', 'fx'].includes(s)) return 'forex';
  if (['commodities', 'commodity', 'emtia'].includes(s)) return 'commodities';
  if (['us_equity', 'abd_hisse', 'stocks', 'stock'].includes(s)) return 'us_equity';
  if (String(symbol || '').endsWith('.P') || /USDT|USDC|BTC|ETH/.test(String(symbol || ''))) return 'crypto';
  return 'default';
}

export function getTrendlineWindow({ timeframe, marketType, symbol }) {
  const tf = normalizeTimeframe(timeframe);
  const mt = normalizeMarketType(marketType, symbol);
  const rules = WINDOW_RULES[mt] || WINDOW_RULES.default;
  const [minBars, maxBars] = rules[tf] || WINDOW_RULES.default['1D'];
  return { marketType: mt, timeframe: tf, minBars, maxBars, targetBars: Math.round((minBars + maxBars) / 2) };
}

// Breakout-retest icin "yakin gecmis" sınırı — timeframe'e gore.
// 240/4H daha hareketli, 1W daha agir. Bu sayilar Codex onerisinden.
function getMaxBreakAgeBars(timeframe) {
  const tf = normalizeTimeframe(timeframe);
  if (tf === '240') return 6;
  if (tf === '1D')  return 5;
  if (tf === '1W')  return 4;
  return 5;
}

function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

function lineValue(a, b, index) {
  if (!a || !b || a.index === b.index) return null;
  const slope = (b.price - a.price) / (b.index - a.index);
  return a.price + slope * (index - a.index);
}

function roundNumber(v, digits = 6) {
  return Number.isFinite(v) ? Number(v.toFixed(digits)) : null;
}

// 2026-05-20 — Codex+Claude mutabakati. Tek tolerans yerine 4 ayri esik:
//   touch              : pivot "temas" sayma sinir (mevcut, korundu)
//   interiorHardReject : P1-P2 arasinda wick ihlali → aday reddedilir
//   posteriorPierce    : P2 sonrasi wick ihlali (close break degil) → flag + confidence ceza
//   closeBreak         : kapanis cizgiyi asti mi → broken=true
//
// Floor degerleri ATR cok kuculurse devreye girer (dusuk vol forex/stable).
function getThresholds({ atrValue, lastClose }) {
  const baseAtr = Number.isFinite(atrValue) && atrValue > 0
    ? atrValue
    : Math.max(lastClose * 0.01, 0);
  return {
    atr: baseAtr,
    touch:              Math.max(baseAtr * 0.35, lastClose * 0.003),
    interiorHardReject: Math.max(baseAtr * 0.40, lastClose * 0.0015),
    posteriorPierce:    Math.max(baseAtr * 0.50, lastClose * 0.002),
    closeBreak:         Math.max(baseAtr * 0.30, lastClose * 0.0015),
  };
}

// 4 trendline tipi. Rol (tavan/taban) sabit, egim isareti tipi belirler:
//   resistance (tavan, swing high'lardan): falling_resistance | rising_resistance
//   support    (taban, swing low'lardan):  rising_support     | falling_support
// "Yanlis taraf" rol'e bagli: tavanda fiyatin USTU, tabanda ALTI ihlaldir —
// egim isaretinden bagimsiz. Bu yuzden wrongSide* fonksiyonlari rol'e bakar.
const RESISTANCE_TYPES = new Set(['falling_resistance', 'rising_resistance']);
const SUPPORT_TYPES = new Set(['rising_support', 'falling_support']);

function isResistance(type) { return RESISTANCE_TYPES.has(type); }

function roleOf(type) {
  if (RESISTANCE_TYPES.has(type)) return 'resistance';
  if (SUPPORT_TYPES.has(type)) return 'support';
  return null;
}

function typeFor(role, slope) {
  if (role === 'resistance') return slope >= 0 ? 'rising_resistance' : 'falling_resistance';
  return slope > 0 ? 'rising_support' : 'falling_support';
}

function wrongSideWickDistance(type, bar, lineAtBar) {
  if (!Number.isFinite(lineAtBar)) return null;
  return isResistance(type) ? bar.high - lineAtBar : lineAtBar - bar.low;
}

function wrongSideCloseDistance(type, bar, lineAtBar) {
  if (!Number.isFinite(lineAtBar)) return null;
  return isResistance(type) ? bar.close - lineAtBar : lineAtBar - bar.close;
}

// P1-P2 arasinda wick cizginin yanlis tarafina interiorHardReject'ten fazla
// tasiyorsa aday reddedilir. Geometrik dogruluk - cizgi gecmis fiyat davranisini
// temsil etmiyor demektir (XRP 14.05.26 vakasi).
function scanInteriorViolation({ type, a, b, bars, threshold }) {
  for (let i = a.index + 1; i < b.index; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const lineAtBar = lineValue(a, b, i);
    const distance = wrongSideWickDistance(type, bar, lineAtBar);
    if (Number.isFinite(distance) && distance > threshold) {
      return {
        index: i,
        time: bar.time,
        price: isResistance(type) ? bar.high : bar.low,
        lineValue: roundNumber(lineAtBar),
        distance: roundNumber(distance),
      };
    }
  }
  return null;
}

// P2 sonrasi: kapanisla cizgi asilmissa "recentCloseBreak" olarak isaretle.
// Son kapanisin asip asmadigi ayrica `broken` flag'iyle bakilir; bu fonksiyon
// gecmiste herhangi bir close break olmus mu, en yenisini doner.
function findMostRecentCloseBreak({ type, a, b, bars, threshold }) {
  const lastIndex = bars.length - 1;
  let latest = null;
  for (let i = b.index + 1; i <= lastIndex; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const lineAtBar = lineValue(a, b, i);
    const distance = wrongSideCloseDistance(type, bar, lineAtBar);
    if (Number.isFinite(distance) && distance > threshold) {
      latest = {
        index: i,
        time: bar.time,
        price: bar.close,
        lineValue: roundNumber(lineAtBar),
        distance: roundNumber(distance),
        ageBars: lastIndex - i,
        direction: isResistance(type) ? 'up' : 'down',
      };
    }
  }
  return latest;
}

// P2 sonrasi sadece wick ile delinmis (kapanis temiz) noktalari topla.
// Close break olanlar buraya girmez - onlar recentCloseBreak'e gider.
function scanPosteriorPierces({ type, a, b, bars, wickThreshold, closeThreshold }) {
  const pierces = [];
  for (let i = b.index + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const lineAtBar = lineValue(a, b, i);
    const wickDist = wrongSideWickDistance(type, bar, lineAtBar);
    const closeDist = wrongSideCloseDistance(type, bar, lineAtBar);
    const isWickPierce = Number.isFinite(wickDist) && wickDist > wickThreshold;
    const isCloseBreak = Number.isFinite(closeDist) && closeDist > closeThreshold;
    if (isWickPierce && !isCloseBreak) {
      pierces.push({
        index: i,
        time: bar.time,
        price: isResistance(type) ? bar.high : bar.low,
        lineValue: roundNumber(lineAtBar),
        distance: roundNumber(wickDist),
      });
    }
  }
  return pierces;
}

// P2 sonrasi fiyat cizginin YANLIS tarafinda kac bar KAPANMIS — oran olarak.
// Wick degil close baz alinir (Bulgu 5 karari: wick/gap ana trendi bozmaz,
// ama kapanis fiyatin gercekten o tarafa yerlestigi anlamina gelir).
function countPosteriorWrongSideCloses({ type, a, b, bars, threshold }) {
  let wrong = 0, total = 0;
  for (let i = b.index + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    total++;
    const lineAtBar = lineValue(a, b, i);
    const closeDist = wrongSideCloseDistance(type, bar, lineAtBar);
    if (Number.isFinite(closeDist) && closeDist > threshold) wrong++;
  }
  return { wrong, total, ratio: total > 0 ? wrong / total : 0 };
}

// Posterior gecerlilik kapisi. Kisa tabanli (P1-P2 yakin) bir cizgi ileriye
// uzatildiginda fiyattan kopar; fiyat cizginin yanlis tarafinda dusturce
// kapanir ama motor cizgiyi "Onayli direnc/destek" diye gosterir (COST 1D
// vakasi: cizgi 970, fiyat 1028, haftalardir ustunde). Cozum: P2 sonrasi
// yeterince bar varken (>=MIN) cogunlugu yanlis tarafta kapandiysa (>MAX_RATIO)
// cizgi artik gecerli S/R degildir → hard reject. Taze/yakin kirilim
// (breakout_retest) korunur cunku oran dusuk kalir (sadece son birkac bar).
const POSTERIOR_STALE_MIN_BARS = 15;
const POSTERIOR_STALE_MAX_RATIO = 0.30;

// `role` ('support'|'resistance') verilirse tip egimden turetilir; geriye donuk
// uyumluluk icin `type` de kabul edilir (testler dogrudan type geciyor).
function buildCandidate({ role, type, a, b, pivots, bars, atrValue, minPivotGap }) {
  const lastIndex = bars.length - 1;
  const currentValue = lineValue(a, b, lastIndex);
  if (!Number.isFinite(currentValue) || currentValue <= 0) return null;

  const slope = (b.price - a.price) / (b.index - a.index);
  if ((b.index - a.index) < minPivotGap) return null;

  // Rol sabit (taban/tavan); egim isareti 4 tipten birini secer. Eski "egim
  // yanlis isarette → reddet" kurallari kaldirildi — yukselen direnc ve dusen
  // destek artik gecerli.
  const lineRole = role || roleOf(type);
  if (!lineRole) return null;
  const lineType = typeFor(lineRole, slope);

  const lastClose = bars[lastIndex].close;
  const thresholds = getThresholds({ atrValue, lastClose });

  // Geometrik gecerlilik — P1-P2 arasi ihlal varsa cizgi yanlis. Hard reject.
  const interiorViolation = scanInteriorViolation({
    type: lineType, a, b, bars, threshold: thresholds.interiorHardReject,
  });
  if (interiorViolation) return null;

  // Posterior gecerlilik — cizgi P2 sonrasi cogunlukla yanlis tarafta kapandiysa
  // artik gerçek S/R degil. Stale/kopuk cizgileri kokten eler.
  const posteriorCloses = countPosteriorWrongSideCloses({
    type: lineType, a, b, bars, threshold: thresholds.closeBreak,
  });
  if (
    posteriorCloses.total >= POSTERIOR_STALE_MIN_BARS &&
    posteriorCloses.ratio > POSTERIOR_STALE_MAX_RATIO
  ) {
    return null;
  }

  const touching = pivots.filter(p => {
    if (p.index < a.index || p.index > lastIndex) return false;
    const v = lineValue(a, b, p.index);
    return Number.isFinite(v) && Math.abs(p.price - v) <= thresholds.touch;
  });

  const posteriorPierces = scanPosteriorPierces({
    type: lineType, a, b, bars,
    wickThreshold: thresholds.posteriorPierce,
    closeThreshold: thresholds.closeBreak,
  });

  // broken = SON barin kapanisi cizgiyi asmis mi (close-confirm).
  const currentCloseDistance = wrongSideCloseDistance(lineType, bars[lastIndex], currentValue);
  const broken = Number.isFinite(currentCloseDistance) && currentCloseDistance > thresholds.closeBreak;

  // recentCloseBreak = P2 sonrasi gecmiste herhangi bir close break (son bar dahil).
  // broken=false ama recentCloseBreak dolu olabilir → "cizgi gecmiste kirildi, fiyat geri dondu".
  const recentCloseBreak = findMostRecentCloseBreak({
    type: lineType, a, b, bars, threshold: thresholds.closeBreak,
  });

  const distancePct = ((lastClose - currentValue) / lastClose) * 100;
  const slopePctPerBar = Math.abs(slope / ((a.price + b.price) / 2)) * 100;
  const tooSteep = slopePctPerBar > 1.8;

  const spanScore = Math.min(1, (b.index - a.index) / Math.max(30, bars.length * 0.35));
  const touchScore = Math.min(1, touching.length / 4);
  const recencyScore = Math.max(0, 1 - ((lastIndex - b.index) / bars.length));
  const breakPenalty = broken ? 0.35 : 0;
  const piercePenalty = posteriorPierces.length ? 0.25 : 0;
  const steepPenalty = tooSteep ? 0.2 : 0;

  const confidence = Math.max(0, Math.min(1,
    0.25 + touchScore * 0.35 + spanScore * 0.25 + recencyScore * 0.15
    - breakPenalty - piercePenalty - steepPenalty
  ));

  return {
    type: lineType,
    role: lineRole,
    points: [
      { time: a.time, price: a.price, index: a.index },
      { time: b.time, price: b.price, index: b.index },
    ],
    currentValue,
    lastClose,
    distancePct,
    touches: touching.map(p => ({ time: p.time, price: p.price, index: p.index })),
    touchCount: touching.length,
    confirmed: touching.length >= 3,
    broken,
    recentCloseBreak,
    pierced: posteriorPierces.length > 0,
    // posteriorPierces payload icin slice(-5) ile sinirli; gercek toplam sayi
    // ayri field olarak tutulur ki UI dogru rakami gostersin (Bug taramasi
    // sonrasi eklendi).
    posteriorPierceCount: posteriorPierces.length,
    posteriorPierces: posteriorPierces.slice(-5),
    tooSteep,
    slope,
    slopePctPerBar,
    thresholds: {
      atr: roundNumber(thresholds.atr),
      touch: roundNumber(thresholds.touch),
      interiorHardReject: roundNumber(thresholds.interiorHardReject),
      posteriorPierce: roundNumber(thresholds.posteriorPierce),
      closeBreak: roundNumber(thresholds.closeBreak),
    },
    confidence: Number(confidence.toFixed(3)),
  };
}

// role: 'support' (swing low'lar) | 'resistance' (swing high'lar). Her pivot
// cifti egim isaretine gore 4 tipten birine dusebilir; en iyi tek cizgi secilir.
function bestTrendline({ role, pivots, bars, atrValue }) {
  if (!Array.isArray(pivots) || pivots.length < 2) return null;
  const recent = pivots.slice(-10);
  const minPivotGap = 8;
  const candidates = [];

  for (let i = 0; i < recent.length - 1; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const c = buildCandidate({ role, a: recent[i], b: recent[j], pivots: recent, bars, atrValue, minPivotGap });
      if (c) candidates.push(c);
    }
  }

  candidates.sort((a, b) =>
    Number(b.confirmed) - Number(a.confirmed)
    || b.confidence - a.confidence
    || b.touchCount - a.touchCount
  );

  return candidates[0] || null;
}

export function calculateTrendlines({ bars, timeframe, marketType, symbol }) {
  if (!Array.isArray(bars) || bars.length < 30) {
    return { support: null, resistance: null, warnings: ['trendline_insufficient_bars'] };
  }

  const win = getTrendlineWindow({ timeframe, marketType, symbol });
  const scopedBars = bars.slice(-Math.min(win.maxBars, MAX_BARS, bars.length));
  const warnings = [];
  if (scopedBars.length < win.minBars) {
    warnings.push(`trendline_window_below_preferred_min:${scopedBars.length}<${win.minBars}`);
  }

  const { swingHighs, swingLows } = findSwingPoints(scopedBars, 3);
  const atrValue = atr(scopedBars, 14);

  return {
    window: win,
    support: bestTrendline({ role: 'support', pivots: swingLows, bars: scopedBars, atrValue }),
    resistance: bestTrendline({ role: 'resistance', pivots: swingHighs, bars: scopedBars, atrValue }),
    warnings,
  };
}

// --- Trendline Plan Candidates (Commit 2) -----------------------------------
// Bu adaylar GERCEK emir plani DEGIL. Sadece olcum/observation icin trendline'a
// dayanan entry/SL fikirleri. Grader'a beslenmez. UI'de bilgi olarak gosterilir.
// Adlandirma: codebase'deki "shadow*" pipeline'iyla karistirilmamali — onlar
// vote/score promotion icin, bu ise trendline-tabanli setup adaylari.

// 2026-05-20 (Codex bug taramasi Bulgu 5 karari):
// PIERCED cizgiler bu kapida ELENMEZ. Kullanici karari: anlik wick veya gap
// hareketleri ana trendi bozmaz. Pierced bilgisi sadece UI'de badge ve
// confidence cezasi (-0.25) olarak yansir; canUseLineForPlan'da gate degildir.
// Eger ileride korelasyon analizi pierced cizgilerin daha kotu WR verdigini
// gosterirse buraya `!line.pierced` eklenebilir.
function canUseLineForPlan(line) {
  return !!(
    line &&
    line.confirmed &&
    !line.tooSteep &&
    Number.isFinite(line.confidence) &&
    line.confidence >= 0.55
  );
}

function makePlanCandidate({ direction, line, planType, source }) {
  if (!line || !Number.isFinite(line.currentValue)) return null;

  const touch = line.thresholds?.touch ?? Math.abs(line.currentValue) * 0.003;
  const stopBuffer = line.thresholds?.closeBreak ?? Math.abs(line.currentValue) * 0.0015;
  const entryBuffer = touch * 0.35;

  const entry = direction === 'long'
    ? line.currentValue + entryBuffer
    : line.currentValue - entryBuffer;

  const sl = direction === 'long'
    ? line.currentValue - stopBuffer
    : line.currentValue + stopBuffer;

  if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry <= 0 || sl <= 0) return null;

  const riskPct = direction === 'long'
    ? ((entry - sl) / entry) * 100
    : ((sl - entry) / entry) * 100;

  if (!Number.isFinite(riskPct) || riskPct <= 0) return null;

  return {
    planType,
    source,
    direction,
    entry: roundNumber(entry),
    sl: roundNumber(sl),
    riskPct: roundNumber(riskPct, 3),
    lineValue: roundNumber(line.currentValue),
    lineConfidence: line.confidence,
    lineTouchCount: line.touchCount,
    lineDistancePct: roundNumber(line.distancePct, 3),
    lineBrokenNow: !!line.broken,
    linePierced: !!line.pierced,
    breakAgeBars: line.recentCloseBreak?.ageBars ?? null,
  };
}

// Test-only export — production code should not import this.
export const __test = {
  buildCandidate,
  bestTrendline,
  roleOf,
  typeFor,
  isResistance,
  getThresholds,
  scanInteriorViolation,
  scanPosteriorPierces,
  countPosteriorWrongSideCloses,
  findMostRecentCloseBreak,
  lineValue,
  getMaxBreakAgeBars,
  canUseLineForPlan,
  makePlanCandidate,
};

// Trendline → sinyal context. Advisory: grade/vote'a etki yok.
//
// 2026-05-20 — pierced icin risk flag + trendlinePlanCandidates eklendi.
//   respect_pullback: recentCloseBreak === null zorunlu (cizgi "saygi goruyor")
//   breakout_retest:  recentCloseBreak zorunlu + yas <= getMaxBreakAgeBars(tf)
//
// 2026-05-20 (Codex bug taramasi sonrasi):
//   - notes/riskFlags artik recentCloseBreak'i dikkate aliyor. Kirilan
//     bir cizgi icin hem "long_near_falling_resistance" hem
//     "breakout_retest_long" plani uretilmiyor (Bulgu 1).
//   - "long_near_confirmed_rising_support" da !recentCloseBreak gate'liyor
//     ki "support gecmiste kirildi ama fiyat geri dondu" durumunda yanlis
//     pozitif not yazilmasin (Bulgu 2).
//   - trendlines.warnings'i ctx.warnings'e tasiyor (Bulgu 3).
//   - PIERCED CIZGILER PLAN URETIR. Kullanici karari: anlik wick/gap
//     hareketleri ana trendi bozmaz; pierced sadece riskFlag/badge olarak
//     gosterilir, plan uretimini engellemez (Bulgu 5 kararı).
export function buildTrendlineSignalContext(trendlines, direction) {
  const support = trendlines?.support || null;
  const resistance = trendlines?.resistance || null;
  const timeframe = trendlines?.window?.timeframe || null;
  const sourceWarnings = Array.isArray(trendlines?.warnings) ? trendlines.warnings : [];
  const maxBreakAgeBars = getMaxBreakAgeBars(timeframe);

  const ctx = {
    support,
    resistance,
    notes: [],
    riskFlags: [],
    // Trendline motorundan gelen warning'ler (ornek: pencere yetersiz).
    // signal-grader bunlari result.warnings'e [Trendline] etiketiyle ekler.
    warnings: sourceWarnings.slice(),
    trendlinePlanCandidates: [],
  };

  // Mesafe gate'leri — Codex onerisi.
  const maxPullbackDistancePct = 3;   // cizgiye yakinlik (respect senaryosu)
  const maxRetestDistancePct   = 4;   // retest icin "geri donus" mesafesi
  const maxFailedRetestPct     = 0.75; // ters tarafa kucuk wick toleransi

  // Bir cizgi "saygi goruyor" kabul edilebilmesi icin: kirilmamis VE gecmiste
  // de kapanisla kirilmamis olmali. recentCloseBreak dolu ise cizgi en az bir
  // kez delinmis demek — respect/note uretmeyiz.
  const supportRespected    = !!(support    && !support.broken    && !support.recentCloseBreak);
  const resistanceRespected = !!(resistance && !resistance.broken && !resistance.recentCloseBreak);

  if (direction === 'long') {
    // Note: taban (yukselen VEYA dusen destek) "saygi goruyor" ve fiyat yakin →
    // long lehine bilgi. Tip string'e yansir (or. long_near_confirmed_falling_support).
    if (support?.confirmed && supportRespected && Math.abs(support.distancePct) <= 2) {
      ctx.notes.push('long_near_confirmed_' + support.type);
    }
    // RiskFlag: tavan (dusen VEYA yukselen direnc) HALEN saygin (kirilmamis +
    // gecmiste kirilmamis) ve fiyat yakin → long icin direnç riski.
    if (resistance?.confirmed && resistanceRespected && resistance.currentValue > 0 && Math.abs(resistance.distancePct) <= 3) {
      ctx.riskFlags.push('long_near_' + resistance.type);
    }
    if (support?.broken) ctx.riskFlags.push('long_support_broken');
    if (support?.pierced) ctx.riskFlags.push('long_support_posterior_pierced');

    // respect_pullback_long — rising_support'a saygi senaryosu.
    // recentCloseBreak varsa cizgi zaten bir kez kirildi, "saygi" bozulmus → uretme.
    if (
      canUseLineForPlan(support) &&
      !support.broken &&
      !support.recentCloseBreak &&
      support.distancePct >= -0.5 &&
      support.distancePct <= maxPullbackDistancePct
    ) {
      const plan = makePlanCandidate({
        direction, line: support,
        planType: 'respect_pullback_long', source: support.type,
      });
      if (plan) ctx.trendlinePlanCandidates.push(plan);
    }

    // breakout_retest_long — kirilan falling_resistance'in retest'i.
    // recentCloseBreak.direction='up' VE yas <= tf sinirinda olmali.
    if (
      canUseLineForPlan(resistance) &&
      resistance.recentCloseBreak?.direction === 'up' &&
      resistance.recentCloseBreak.ageBars <= maxBreakAgeBars &&
      resistance.distancePct >= -maxFailedRetestPct &&
      resistance.distancePct <= maxRetestDistancePct
    ) {
      const plan = makePlanCandidate({
        direction, line: resistance,
        planType: 'breakout_retest_long', source: resistance.type,
      });
      if (plan) ctx.trendlinePlanCandidates.push(plan);
    }
  }

  if (direction === 'short') {
    if (resistance?.confirmed && resistanceRespected && Math.abs(resistance.distancePct) <= 2) {
      ctx.notes.push('short_near_confirmed_' + resistance.type);
    }
    if (support?.confirmed && supportRespected && Math.abs(support.distancePct) <= 3) {
      ctx.riskFlags.push('short_near_' + support.type);
    }
    if (resistance?.broken) ctx.riskFlags.push('short_resistance_broken');
    if (resistance?.pierced) ctx.riskFlags.push('short_resistance_posterior_pierced');

    // respect_pullback_short — falling_resistance'a saygi.
    if (
      canUseLineForPlan(resistance) &&
      !resistance.broken &&
      !resistance.recentCloseBreak &&
      resistance.distancePct >= -maxPullbackDistancePct &&
      resistance.distancePct <= 0.5
    ) {
      const plan = makePlanCandidate({
        direction, line: resistance,
        planType: 'respect_pullback_short', source: resistance.type,
      });
      if (plan) ctx.trendlinePlanCandidates.push(plan);
    }

    // breakout_retest_short — kirilan rising_support'un retest'i.
    if (
      canUseLineForPlan(support) &&
      support.recentCloseBreak?.direction === 'down' &&
      support.recentCloseBreak.ageBars <= maxBreakAgeBars &&
      support.distancePct >= -maxRetestDistancePct &&
      support.distancePct <= maxFailedRetestPct
    ) {
      const plan = makePlanCandidate({
        direction, line: support,
        planType: 'breakout_retest_short', source: support.type,
      });
      if (plan) ctx.trendlinePlanCandidates.push(plan);
    }
  }

  return ctx;
}
