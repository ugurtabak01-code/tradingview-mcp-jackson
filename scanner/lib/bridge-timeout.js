/**
 * Bridge timeout — CDP roundtrip'lerini op-specifik timeout ile sarmalar.
 *
 * Motivasyon (Patch 2, 2026-05-23):
 *   tv-bridge.js fonksiyonlari TradingView Desktop'a CDP uzerinden gidip
 *   gelir. CDP donarsa (chrome process hung, network glitch, page reload)
 *   underlying Promise asla resolve etmez. Bu durum bir TF taramasini ve
 *   onunla birlikte tutulan chart-mutex'i suresiz bekletir; scheduler ve
 *   diger scanner cagrilari bloke olur.
 *
 *   Fix: her public bridge fonksiyonu op-spesifik timeout ile sarmalanir.
 *   Timeout fire ettiginde `error.code = 'CDP_TIMEOUT'` ile reject; cagiran
 *   tarafindaki .catch() yutarsa TF HATA grade'iyle duser, scanShortTerm
 *   finally bloku ile chart-mutex serbest birakilir.
 *
 *   NOT: Underlying CDP request hala arka planda asili kalabilir
 *   (Patch 3a CDP cancel feasibility ile ele alinacak). Bu helper sadece
 *   scan-engine seviyesinde ilerlemeyi garanti eder, alt katman temizligi
 *   degil.
 */

/**
 * Op basina timeout (ms). Env var ile runtime'da override edilebilir:
 *   BRIDGE_TIMEOUT_SET_SYMBOL=45000 BRIDGE_TIMEOUT_GET_OHLCV=20000 ...
 *
 * Degerler emniyet payi ile secildi:
 *   - setSymbol: chart sembol yuklemesini bekler; 7/24 olmayan sembollerde
 *     (BIST off-hours) 10-15s'i bulabiliyor → 30s default.
 *   - setTimeframe: hizli (~1-2s) ama bar yeniden yukleme tetiklerse uzar.
 *   - getOhlcv: 100 bar dump ~2s; chart busy ise 10s'i gecebilir.
 *   - getStudyValues: tum chart study'lerini gezer; 8-10s normal.
 *   - getQuote / getCurrentBareSymbol / getChartState: anlik state, <1s.
 *   - readSMC: SMC indicator yuklu ise study traverse'i 5-8s.
 */
function fromEnv(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const BRIDGE_TIMEOUTS = {
  setSymbol:            fromEnv('BRIDGE_TIMEOUT_SET_SYMBOL', 30000),
  setTimeframe:         fromEnv('BRIDGE_TIMEOUT_SET_TF',     15000),
  getOhlcv:             fromEnv('BRIDGE_TIMEOUT_GET_OHLCV',  15000),
  getOhlcvValidated:    fromEnv('BRIDGE_TIMEOUT_GET_OHLCV',  15000),
  getStudyValues:       fromEnv('BRIDGE_TIMEOUT_STUDY',      12000),
  getQuote:             fromEnv('BRIDGE_TIMEOUT_QUOTE',      10000),
  getCurrentBareSymbol: fromEnv('BRIDGE_TIMEOUT_BARE_SYM',    8000),
  getChartState:        fromEnv('BRIDGE_TIMEOUT_CHART_STATE', 8000),
  readSMC:              fromEnv('BRIDGE_TIMEOUT_SMC',        15000),
  default:              fromEnv('BRIDGE_TIMEOUT_DEFAULT',    10000),
};

/**
 * CDP timeout error — code-driven, scheduler/dashboard tarafindan
 * kategorize edilebilir. Patch 5 (D14) ile errors.js'e tasinacak; simdilik
 * inline factory.
 */
export class CdpTimeoutError extends Error {
  constructor(op, timeoutMs) {
    super(`[CDP_TIMEOUT] ${op} ${timeoutMs}ms icinde donmedi`);
    this.name = 'CdpTimeoutError';
    this.code = 'CDP_TIMEOUT';
    this.op = op;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Promise'i op-spesifik timeout ile sarmalar.
 *
 *   await withCdpTimeout(bridge.setSymbol('BTCUSDT'), 'setSymbol');
 *
 * @param {Promise} promise — sarmalanacak CDP cagrisi
 * @param {string} op — BRIDGE_TIMEOUTS key'i (orn. 'setSymbol'). Bilinmeyen
 *   op icin BRIDGE_TIMEOUTS.default kullanilir.
 * @returns {Promise} — promise sonucu veya CdpTimeoutError
 */
export function withCdpTimeout(promise, op) {
  const ms = BRIDGE_TIMEOUTS[op] ?? BRIDGE_TIMEOUTS.default;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CdpTimeoutError(op, ms)), ms);
  });
  // Promise.race: hangisi once dondurursa o kazanir. Timer'i temizle ki
  // GC ve test sonrasi pending handle uyarisi olmasin.
  return Promise.race([promise, timeoutPromise])
    .then(result => { recordCdpSuccess(); return result; })
    .catch(err => { if (isCdpTimeoutError(err)) recordCdpTimeout(); throw err; })
    .finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * isCdpTimeoutError — caller'larin spesifik catch yazabilmesi icin guard.
 */
export function isCdpTimeoutError(err) {
  return Boolean(err && err.code === 'CDP_TIMEOUT');
}

// ---------------------------------------------------------------------------
// Patch 3b — Consecutive timeout sayaci + reconnect bayragi
// ---------------------------------------------------------------------------
//
// CDP gercek bir cancel mekanizmasi sunmuyor (bkz. docs/cdp-cancel-feasibility.md);
// asili kalan setSymbol/setTimeframe gibi cagrilar arka planda devam edebilir.
// Ardisik N=3 timeout = gercek hung (tek timeout muhtemelen gecici hickirik).
// Bu durumda reconnect bayragi set edilir; bir sonraki getClient cagrisi
// otomatik olarak yeni bir CDP baglantisi kurar (cdp-connection.js zaten
// chart-API check ile reconnect mantigini desteklyor).
//
// Onemli: bu modul disconnect()/connect()'i CAGIRMAZ — sadece bayragi
// set eder. Actual reconnect cdp-connection.js'in getClient mantigi
// tarafindan yapilir. Boylece chart-mutex tutarken reconnect tetiklenmez;
// finally bloku release ettikten sonra bir sonraki scan reconnect'i tetikler.
//
// recordCdpSuccess / recordCdpTimeout / shouldReconnect saf fonksiyonlar
// (disk/network bagimsiz) → test-edilebilir.

const RECONNECT_THRESHOLD = parseInt(process.env.CDP_RECONNECT_THRESHOLD, 10) > 0
  ? parseInt(process.env.CDP_RECONNECT_THRESHOLD, 10)
  : 3;

let _consecutiveTimeouts = 0;
let _needsReconnect = false;

export function recordCdpSuccess() {
  if (_consecutiveTimeouts > 0) {
    console.log(`[CDP] Sayac sifirlandi (basarili call); onceki ardisik timeout: ${_consecutiveTimeouts}`);
  }
  _consecutiveTimeouts = 0;
}

export function recordCdpTimeout() {
  _consecutiveTimeouts += 1;
  console.warn(`[CDP] Timeout sayaci: ${_consecutiveTimeouts}/${RECONNECT_THRESHOLD}`);
  if (_consecutiveTimeouts >= RECONNECT_THRESHOLD) {
    _needsReconnect = true;
    console.warn(`[CDP] ${RECONNECT_THRESHOLD} ardisik timeout — reconnect bayragi set edildi`);
  }
}

export function shouldReconnect() {
  return _needsReconnect;
}

export function clearReconnectFlag() {
  _needsReconnect = false;
  _consecutiveTimeouts = 0;
}

/**
 * Test/teshis amacli iç state'i okuma — public API'nin parcasi degil,
 * sadece testler ve admin endpoint'leri icin.
 */
export function _getCdpCounterState() {
  return {
    consecutiveTimeouts: _consecutiveTimeouts,
    needsReconnect: _needsReconnect,
    threshold: RECONNECT_THRESHOLD,
  };
}
