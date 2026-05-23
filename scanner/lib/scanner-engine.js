/**
 * Scanner Engine — the core scanning workflow.
 *
 * KhanSaab Sniper best-practice (from indicator author):
 *   1. Check trend on higher TFs first (4H → 1H → 30m → 15m)
 *   2. Execute on asset-specific lower TFs:
 *      - Crypto/Gold scalp: 1m/3m/5m | Intraday: 5m/15m
 *      - Stocks intraday: 5m (with 15/30/1H/4H trend confirmation)
 *      - Commodities: 5m primary
 *      - Conservative: 15m
 *   3. Always use SMC indicator alongside for S&R / order blocks
 *   4. VWAP is key magnet/S&R for liquid instruments
 */

import * as _rawBridge from './tv-bridge.js';
import { withCdpTimeout, BRIDGE_TIMEOUTS, shouldReconnect, clearReconnectFlag } from './bridge-timeout.js';
import { disconnect as _cdpDisconnect } from './cdp-connection.js';

// Patch 2 — CDP timeout proxy. Sadece BRIDGE_TIMEOUTS'ta listelenen op'lar
// sarmalanir (setSymbol, setTimeframe, getOhlcv*, getStudyValues, getQuote,
// getCurrentBareSymbol, getChartState, readSMC). waitForDataChange ve
// getBarSnapshot pass-through kalir (kendi timeout/anlik state mantiklari var).
// 28 call-site'i tek tek sarmamak yerine Proxy ile tum bridge.X(...) cagrilari
// otomatik timeout-korumali hale gelir; CDP donarsa CdpTimeoutError throw eder
// ve TF HATA grade'iyle duser, scan finally bloku chart-mutex'i serbest birakir.
const _WRAPPED_OPS = new Set(Object.keys(BRIDGE_TIMEOUTS).filter(k => k !== 'default'));
const bridge = new Proxy(_rawBridge, {
  get(target, prop) {
    const fn = target[prop];
    if (typeof fn !== 'function' || !_WRAPPED_OPS.has(prop)) return fn;
    return (...args) => withCdpTimeout(fn.apply(target, args), prop);
  },
});
import { detectFormations, checkVolumeConfirmation } from './formation-detector.js';
import { calculateTrendlines } from './trendline-engine.js';
import { detectRSIDivergence, detectSqueeze, analyzeCDV, parseSMCLabels, getVolatilityRegime, calculateStochRSI, getCategorySLBoost, parseSMCBoxes, parseSMCLines, calcTechnicals,
  // Patch 2 — shadow primitives (Lloyd 2013, Swanson 2014, King 2022, Boroden 2008)
  calcCMF, calcMFI, calcMAStack, calcMACross, calcMACDExtended,
  detectRsiThresholdCross, detectRsiFailureSwing, tagMitigation, classifyCleanBreak,
  deriveLiquidityBias, deriveStrongPivotBias, findFibCluster, priceInGoldenZone,
  computeMtfScore } from './calculators.js';
import { loadFibCache, checkFibCacheAge, refreshHTFFibForSymbol } from './fib-engine.js';
import { gradeShortTermSignal, gradeLongTermSignal } from './signal-grader.js';
import { getMacroState, applyMacroFilter, formatMacroSummary } from './macro-filter.js';
import { classifyRegime } from './learning/regime-detector.js';
// Faz 1 İter 2 — shadow-only rejim modülü (sinyal akışına bağlı DEĞİL)
import { computeRegime as _shadowComputeRegime } from './learning/compute-regime.js';
import { logRegime as _shadowLogRegime } from './learning/regime-shadow-logger.js';
import { categoryToMarketType as _shadowCategoryToMarketType } from './learning/regime-profiles.js';
// Risk #5 — Parser kirilma korumasi (sema validation + alarm counter)
import { gateTechnicals, gateSMC } from './parser-validator.js';
import { recordSignal } from './learning/signal-tracker.js';
import { buildDecisionSnapshot, recordDecisionSnapshot } from './learning/decision-snapshot-recorder.js';
import { buildFundamentalSnapshot } from './fundamental/index.js';
import { computeShadowFeatures } from './learning/shadow-features.js';
import { loadWeights } from './learning/weight-adjuster.js';
import { resolveSymbol, inferCategory } from './symbol-resolver.js';
import {
  symbolSwitchFailed, barDataTimeout, chartSymbolMismatch,
  ohlcvContaminated, ohlcvStale, ohlcvDeviation,
} from './errors.js';
import { recordShadowDrop } from './shadow-metrics.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Global chart mutex — only ONE process can use TradingView chart at a time ---
// This prevents scheduler, manual scans, macro checks, and learning loop from
// interfering with each other on the single TradingView chart window.
let _scanActive = false;
let _lockHolder = null;
let _lockQueue = [];

export function isScanActive() { return _scanActive; }
export function getLockHolder() { return _lockHolder; }

/**
 * Acquire the chart mutex. Only ONE holder can have it at a time.
 * Others wait in a FIFO queue until the current holder releases.
 * Optional timeout (ms) — rejects if lock not acquired within timeout.
 */
export function acquireScanLock(holder = 'unknown', timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer = null;

    // forced=true: releaseScanLock'tan FIFO devir; _scanActive=true olsa bile al.
    // Donus degeri: 'acquired' | 'timed_out' | 'queued'. Release path bu degeri
    // okuyup transfer arasi timeout durumunda bir sonraki waiter'a kaydirir
    // (aksi halde lock leak — _scanActive true kalir).
    const tryAcquire = (forced = false) => {
      if (timedOut) return 'timed_out';
      if (forced || !_scanActive) {
        if (timer) clearTimeout(timer);
        _scanActive = true;
        _lockHolder = holder;
        console.log(`[Lock] Chart kilidi alindi: ${holder}`);
        resolve();
        return 'acquired';
      } else {
        console.log(`[Lock] Chart mesgul (${_lockHolder}), kuyrukta bekliyor: ${holder}`);
        _lockQueue.push({ tryAcquire, reject });
        return 'queued';
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const idx = _lockQueue.findIndex(w => w.tryAcquire === tryAcquire);
        if (idx >= 0) _lockQueue.splice(idx, 1);
        reject(new Error(`[Lock] Timeout: ${holder} ${timeoutMs}ms bekledikten sonra kilidi alamadi (mevcut: ${_lockHolder})`));
      }, timeoutMs);
    }

    tryAcquire();
  });
}

export function releaseScanLock() {
  const prev = _lockHolder;
  console.log(`[Lock] Chart kilidi birakildi: ${prev || 'unknown'}`);
  // FIFO devri: kuyrukta bekleyen varsa _scanActive'i true tutarak dogrudan
  // o waiter'a aktariyoruz (atomik transfer). Aksi halde release ile yeni
  // bekleyenin uyandirilmasi arasinda disaridan gelen senkron acquireScanLock
  // cagrisi kuyruktan once kilidi kapip kuyrugun sirasini bozabilir
  // (starvation / FIFO ihlali).
  // Transfer arasi timeout fire ederse (waiter zaten reject olmus) sonraki
  // waiter'a kaydir. Aksi halde kilit leak olur: _scanActive=true, holder yok.
  const transferNext = () => {
    while (_lockQueue.length > 0) {
      const waiter = _lockQueue.shift();
      _lockHolder = '<transferring>';
      const status = (() => {
        try { return waiter.tryAcquire(true); } catch (e) { console.warn(`[Lock] waiter tryAcquire hata: ${e?.message}`); return 'error'; }
      })();
      if (status === 'acquired') return true;
      // timed_out veya error → bir sonraki waiter'i dene
    }
    return false;
  };

  if (_lockQueue.length > 0) {
    queueMicrotask(() => {
      if (!transferNext()) {
        _scanActive = false;
        _lockHolder = null;
      }
    });
    _lockHolder = '<transferring>';
  } else {
    _scanActive = false;
    _lockHolder = null;
  }
}

/**
 * Drain the lock queue — reject all waiting lock requests.
 * Called when scheduler is fully stopped to prevent orphaned waiters.
 */
export function drainLockQueue() {
  const drained = _lockQueue.length;
  const queue = _lockQueue.splice(0);
  for (const waiter of queue) {
    try { waiter.reject(new Error('[Lock] Kuyruk temizlendi — scheduler durduruldu')); } catch {}
  }
  if (drained > 0) {
    console.log(`[Lock] Kuyruk temizlendi: ${drained} bekleyen istek iptal/reject edildi`);
  }
  return drained;
}

/**
 * Patch 3b — Scan lifecycle helper.
 *
 * Üç top-level scan entry point'i (scanShortTerm/scanLongTerm/batchScan) aynı
 * pattern'i tekrarliyor:
 *   await acquireScanLock(holder);
 *   try { return await innerFn() } finally { releaseScanLock() }
 *
 * Patch 3b iki yenilik ekliyor:
 *   1. Lock acquire'a timeout (default 5 dk, SCAN_LOCK_TIMEOUT_MS env override) —
 *      CDP donmus bir holder lock'u suresiz tutmasin. Mevcut acquireScanLock
 *      timeoutMs param'i zaten destekliyor; burada uygulaniyor.
 *   2. finally release SONRASI shouldReconnect() true ise async disconnect()
 *      tetiklenir. Sonraki getClient cagrisi otomatik yeni baglanti kurar
 *      (cdp-connection.js reconnect mantigi mevcut). Reconnect mutex DISINDA
 *      cunku release zaten yapilmis — yeni scan beklerken arka planda yenileniyor.
 *
 * Bu helper DRY icin; mantik scanShortTerm/Long/batch arasinda tek tek
 * tekrarlanmasin diye.
 */
const SCAN_LOCK_TIMEOUT_MS = parseInt(process.env.SCAN_LOCK_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.SCAN_LOCK_TIMEOUT_MS, 10)
  : 300000; // 5 dk

async function withScanLifecycle(holder, fn) {
  await acquireScanLock(holder, SCAN_LOCK_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    releaseScanLock();
    // Release SONRASI reconnect kontrolu — mutex DIŞINDA fire-and-forget.
    // Bir sonraki getClient zaten reconnect yapacak; biz sadece eski
    // baglantiyi proaktif kapatip yeni client'a temiz baslangic veriyoruz.
    if (shouldReconnect()) {
      clearReconnectFlag();
      console.warn('[CDP] Reconnect tetikleniyor (ardisik timeout esigi asildi)');
      _cdpDisconnect().catch(err => console.warn(`[CDP] disconnect hata: ${err?.message}`));
    }
  }
}
const RULES_PATH = path.resolve(__dirname, '../../rules.json');

// --- Timeframe presets by asset class ---
//
// KISA VADE:
//   EXEC_TFS  = giris yeri tespiti (tam veri toplama + grading): 15m, 30m, 45m
//   TREND_TFS = trend tespiti (study values + yon): 1H, 4H, 1D, 3D
//   1m/3m/5m kaldirildi — gurultu cok, sinyal kalitesi dusuk.
//
// UZUN VADE:
//   LONG_ENTRY_TF = giris yeri tespiti: 1D
//   LONG_TERM_TFS = trend tespiti: 1D, 3D, 1W, 1M
//   Trend yonu disinda trade onerilmez.
// HTF alignment: 1D sert kapi, 1W bilgilendirici (2026-04-23).
// 1h/4h trend teyidi EXEC_TFS icinde dogal olarak gerceklesiyor.
const TREND_TFS = {
  crypto:    ['1D', '1W'],
  kripto:    ['1D', '1W'],
  emtia:     ['1D', '1W'],
  abd_hisse: ['1D', '1W'],
  forex:     ['1D', '1W'],
  bist:      ['1D', '1W'],
  default:   ['1D', '1W'],
};

// NOT: 45m TF, COINBASE / BINANCE / TVC gibi feedlerde sik sik bos / contaminated
// bar dondurdugu icin kripto/emtia/forex/default icin kapali. Sonuc: signal-grader
// entry deviation > 50% kontrolunden gecemiyor ve HATA grade'iyle dusuyordu.
// Spec (CLAUDE.md "kisa vadeli trade tarama") "15m, 30m ve 1h" diyor — 60m zaten
// TREND_TFS icinde.
//
// abd_hisse + bist (2026-04-18 guncellemesi): 30m TF kapatildi.
// Canli veride 30m WR %17 / PF 0.34 / exp -0.53R — kategori ne olursa olsun
// 30m hisse sinyalleri zarar ettiriyor. Hisse feedleri (NASDAQ/NYSE/BIST) kripto
// feedleri gibi bar contamination sorunu yasamadigi icin 45m guvenli, ayrica
// 45m real WR %12.5 olsa bile PF 2.2 (kazananlar buyuk). Trend teyidi TREND_TFS
// tarafindan saglaniyor (60m/4H/1D) — degismedi.
// 2026-04-23: 15m/30m/45m kapatildi.
// 2026-05-02: 1H (60) kapatildi — kisa TF gurultusu sebebiyle WR/ROI dusuyor.
// Sinyal uretimi 4H + 1D'de; teyit per-TF dinamik (4H→1D+1W, 1D→1W) —
// confirmTFsForExec() icinde belirleniyor.
const EXEC_TFS = {
  crypto:    ['240', '1D'],
  kripto:    ['240', '1D'],
  emtia:     ['240', '1D'],
  abd_hisse: ['240', '1D'],
  forex:     ['240', '1D'],
  bist:      ['240', '1D'],
  default:   ['240', '1D'],
};

/**
 * Pozisyon TF'sine gore dinamik teyit TF'leri.
 *   4H ('240') pozisyon → 1D + 1W teyidi
 *   1D pozisyon         → 1W teyidi (1D kendisi sinyal, gate'lenemez)
 *   Diger (singleTF: 4H/1D disi) → tum HTF set
 */
function confirmTFsForExec(execTF) {
  if (execTF === '240') return ['1D', '1W'];
  if (execTF === '1D')  return ['1W'];
  return ['1D', '1W'];
}

const LONG_TERM_TFS = ['1D', '3D', '1W', '1M'];
const LONG_ENTRY_TF = '1D';

// ---------------------------------------------------------------------------
// Patch 4 — getAssetCategory: 3 kademeli kategorize
// ---------------------------------------------------------------------------
//
// Eski davranis substring tabanli idi ve yanlis eslesmeler uretiyordu:
//   - 'SOLAR'.includes('SOL') → kripto (yanlis; SOLAR hisse senedi)
//   - 'PGSUS'.includes('PG')  → eskiden abd_hisse'ye dusuyordu (commit'te
//     duzeltilmis, ama substring kalintilari hala var)
//
// Yeni davranis 3 kademe — exact match'i her zaman onceleyen:
//   1. Watchlist EXACT match (rules.json) — bilinen sembol her seyden once.
//   2. Index whitelist (USDT.D, BTC.D, DXY, VIX, US10Y, ...) — default.
//   3. Suffix/prefix kural seti — Bilinen suffix'le bitiyorsa veya
//      bilinen "named pair" pattern'i ise kategorize et:
//        - .P / USDT / USDC suffix → kripto (perp/spot)
//        - XAU/XAG/COPPER ile basliyor veya bitiyorsa → emtia
//        - Bilinen 6-harf forex pair (EURUSD, GBPUSD, ...) → forex
//   Hicbiri eslesmezse 'default'.
//
// assignAssetCategory saf fonksiyon (watchlist parametre); getAssetCategory
// rules.json'dan cekip cagiriyor — boylece testler watchlist mock'lamadan
// saf logic'i dogrulayabiliyor.

const _INDEX_WHITELIST = new Set([
  'USDT.D', 'BTC.D', 'ETH.D', 'OTHERS.D',
  'DXY', 'VIX', 'US10Y', 'US02Y', 'US30Y',
]);

const _FOREX_PAIRS = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD',
  'EURCHF', 'EURJPY', 'GBPJPY', 'NZDUSD', 'EURGBP',
]);

const _COMMODITY_TOKENS = new Set(['XAU', 'XAG', 'COPPER', 'WTI', 'BRENT']);

/**
 * Saf kategorize fonksiyonu — watchlist parametre olarak alir. Test edilebilir.
 * Donus: 'crypto' | 'emtia' | 'forex' | 'abd_hisse' | 'bist' | 'kripto' | 'default'
 * (watchlist key'leri ne ise o; substring tahminden farkli olabilir).
 */
export function assignAssetCategory(symbol, watchlist) {
  if (!symbol) return 'default';
  const s = String(symbol).toUpperCase();
  const bare = s.includes(':') ? s.split(':')[1] : s;

  // 1. Watchlist exact match (her seyden once — kullanici tanimli)
  if (watchlist && typeof watchlist === 'object') {
    for (const [cat, syms] of Object.entries(watchlist)) {
      if (!Array.isArray(syms)) continue;
      if (syms.some(ws => String(ws).toUpperCase() === bare)) return cat;
    }
  }

  // 2. Index whitelist (dominance / yield / vol index)
  if (_INDEX_WHITELIST.has(bare)) return 'default';

  // 3. Suffix/prefix kural seti
  // 3a. Forex — exact 6-letter pair match (subset yok, sadece tam isim)
  if (_FOREX_PAIRS.has(bare)) return 'forex';

  // 3b. Kripto — perp/spot suffix kurallari
  //   Perpetual: 'BTCUSDT.P', 'ETHUSDT.P', ...
  //   Spot kripto: 'BTCUSDT', 'ETHUSDC', 'SOLUSDT', ... (USDT/USDC ile biten)
  if (/\.P$/i.test(bare)) return 'crypto';
  if (/(USDT|USDC|BUSD|DAI)$/i.test(bare)) return 'crypto';

  // 3c. Emtia — XAU/XAG/COPPER ile baslayan veya biten (XAUUSD, USDXAU vs.)
  for (const tok of _COMMODITY_TOKENS) {
    if (bare.startsWith(tok) || bare.endsWith(tok)) return 'emtia';
  }

  // 4. Fallback
  return 'default';
}

/**
 * Determine asset category from symbol name (watchlist'i rules.json'dan ceker).
 */
function getAssetCategory(symbol) {
  try {
    const rules = loadRules();
    return assignAssetCategory(symbol, rules?.watchlist);
  } catch {
    return assignAssetCategory(symbol, null);
  }
}

/**
 * Scanner-engine'in dahili getAssetCategory ciktisini ('crypto'|'emtia'|'forex'|'abd_hisse'|...)
 * symbol-resolver'in bekledigi kategori adlarina ('kripto'|'emtia'|'forex'|'abd_hisse'|...)
 * cevirir. Bilinmeyen kategorilerde rules.json watchlist'inden inferCategory kullanilir.
 */
function resolveChartSymbol(symbol) {
  if (!symbol) return symbol;
  if (String(symbol).includes(':')) return symbol; // Zaten prefix'li

  const bare = String(symbol).toUpperCase();
  let cat = getAssetCategory(bare);
  // 'crypto' → 'kripto', 'default' → watchlist'ten infer
  if (cat === 'crypto') cat = 'kripto';
  if (cat === 'default' || !cat) {
    try {
      const rules = loadRules();
      cat = inferCategory(bare, rules?.watchlist) || null;
    } catch {
      cat = null;
    }
  }
  return resolveSymbol(bare, cat);
}

/**
 * Get execution TFs for a symbol based on its asset class.
 */
function getExecTFs(symbol) {
  const cat = getAssetCategory(symbol);
  return EXEC_TFS[cat] || EXEC_TFS.default;
}

/**
 * Get trend confirmation TFs for a symbol based on its asset class.
 */
function getTrendTFs(symbol) {
  const cat = getAssetCategory(symbol);
  return TREND_TFS[cat] || TREND_TFS.default;
}

// ---------------------------------------------------------------------------
// Patch 4 — loadRules() mtime cache
// ---------------------------------------------------------------------------
// rules.json scanner-engine icinde 5-10 kez/scan cagriliyor (getAssetCategory,
// resolveChartSymbol, batchScan, vb.). Her cagri sync readFile + JSON.parse;
// scan basina ~50-100μs israfi. mtime degismedikce parsed sonucu sakla.
//
// Guvenlik: rules.json sadece bu Node process'i tarafindan yaziliyor (server.js
// writeRulesAtomic: tmp + rename). Multi-process yazim YOK → mtime invalidate
// guvenli. External editor manuel duzenleyebilir; mtime check yine yakalar.
let _rulesCache = null;
let _rulesCacheMtimeMs = null;

export function loadRules() {
  try {
    const st = fs.statSync(RULES_PATH);
    if (_rulesCache && _rulesCacheMtimeMs === st.mtimeMs) {
      return _rulesCache;
    }
    const parsed = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
    _rulesCache = parsed;
    _rulesCacheMtimeMs = st.mtimeMs;
    return parsed;
  } catch (e) {
    // Stat/read hatasi → cache atla, ham read'e dus (eski davranis).
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
  }
}

/**
 * Test/teshis amacli — cache'i sifirlamak gerekirse (orn. test izolasyonu).
 */
export function _resetRulesCache() {
  _rulesCache = null;
  _rulesCacheMtimeMs = null;
}

/**
 * Chart'ta okunan bare-symbol (`bridge.getCurrentBareSymbol()` ciktisi) bekleneni
 * tutuyor mu? FAIL-CLOSED: actual null/undefined/bos string ise BASARISIZ kabul
 * edilir (eski `if (actual && actual !== expected)` davranisi bridge state'i
 * okuyamadiginda guard'i ATLIYORDU — sembol switch sirasinda CDP donarsa stale
 * sembolden gelen barlar 'dogrulanmis' sayilabilirdi).
 *
 * Dönüş: { ok, reason }
 *   ok=true: actual === expected (uppercase exact match)
 *   ok=false: actual null/undefined/'' VEYA actual !== expected; reason aciklayicidir
 *
 * Helper export edilir ki scanner-engine'in dis kullanicilari da ayni dogrulama
 * tutarsiziligini tekrar etmesin; testler bu helper'i dogrudan calistirabilsin.
 */
export function assertBareSymbolMatch(actual, expected) {
  if (expected == null || expected === '') {
    return { ok: false, reason: 'expected bare-symbol bos' };
  }
  if (actual == null || actual === '') {
    return { ok: false, reason: 'bridge sembol durumu okunamadi (null) — fail-closed' };
  }
  const a = String(actual).toUpperCase();
  const e = String(expected).toUpperCase();
  if (a !== e) {
    return { ok: false, reason: `chart sembolu uyumsuz: ${a} vs ${e}` };
  }
  return { ok: true, reason: null };
}

/**
 * Deviation retry sonrasi OHLCV swap'i. Eski davranis sadece `bars` ve
 * `total_bars` alanlarini mutate ediyordu; geri kalan alanlar (`stale`,
 * `lastBarAge`, `lastBarTimestamp`, `symbolMismatch`, ...) orijinal degerinde
 * kaliyor ve downstream learning/grader yanilticisi olabiliyordu.
 *
 * Yeni davranis: retry sonucunun tum alanlarini orijinalin uzerine yaz (immutable
 * spread). Mutation yok — caller yeni objeyi atayarak kullanir.
 */
export function mergeDeviationRetry(orig, retry) {
  if (!retry || !Array.isArray(retry.bars) || retry.bars.length === 0) return orig;
  return { ...(orig || {}), ...retry };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function tfLabel(tf) {
  const labels = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '45': '45m', '60': '1H', '120': '2H', '240': '4H', '1D': '1D', '3D': '3D', '1W': '1W', '1M': '1M' };
  return labels[tf] || tf;
}

/**
 * Patch 6 — adım 2: Chart hazırlık katmanı.
 *
 * Sorumluluk: chart'i istenen sembol + TF'ye getir, bar verisinin gerçekten
 * yenilendiğini doğrula, ve veri okumadan ÖNCE sembolün doğru olduğunu
 * kontrol et. Hata varsa ScanError throw eder (factory'lerden).
 *
 * Side effect: chart state (TradingView Desktop) değişir. Bridge çağrıları
 * içerir; saf değildir, mock'suz test edilemez. Davranışı mevcut 229
 * regression test'i kanıtlar (refactor öncesi/sonrası).
 *
 * Dönüş: { chartSymbol, bareExpected } — sonraki katmanların ihtiyacı
 * olan context.
 */
async function ensureChartReady(symbol, tf) {
  const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const chartSymbol = resolveChartSymbol(symbol);

  // Take bar snapshot BEFORE switching symbol/TF — used to detect data change
  const prevSnapshot = await bridge.getBarSnapshot().catch(() => null);

  const symResult = await bridge.setSymbol(chartSymbol);
  if (symResult.success === false) {
    throw symbolSwitchFailed(symbol, chartSymbol, symResult.warning || 'bilinmeyen hata');
  }
  await bridge.setTimeframe(tf);

  // DATA-LEVEL wait: bars collection MUST actually change after the symbol switch.
  //
  // Bug 2026-05-23: TradingView `chart.symbol()` istenen sembolu setSymbol cagrisi
  // ile aninda dondurur — fakat mainSeries().bars() koleksiyonu yeni sembolun
  // barlarini henuz yuklemiyor olabilir. BTCUSD gibi 7/24 trade goren bir sembol
  // chart'ta yuklu iken sonraki sembol (ETHUSDC, BTCXAU, ETHXAU, MONUSD…)
  // yuklenmezse: chart.symbol() yeni adi (sembol guard'i pass), bars hala BTC'nin
  // (stale guard pass — BTC barlari fresh), quote ve ohlcv ayni mainSeries.bars()
  // kaynagindan okudugu icin deviation %0 (sapma guard'i pass) → kirletilmis
  // BTC entry/SL/TP'siyle 5+ sembol icin sinyal uretildi, OKX Executor'a dispatch.
  // Bu sebeple "bars degismedi" durumu artik fatal: bir kez setSymbol retry'i,
  // hala degismediyse abort.
  let dataChangeResult = await bridge.waitForDataChange(prevSnapshot, 10000);
  if (!dataChangeResult.changed) {
    console.log(`[Scanner] ${symbol} TF${tf}: Bar verisi degismedi (10s) — setSymbol yeniden deneniyor`);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    dataChangeResult = await bridge.waitForDataChange(prevSnapshot, 10000);
    if (!dataChangeResult.changed) {
      throw barDataTimeout(symbol, tf);
    }
  }

  // CRITICAL: Verify chart is ACTUALLY showing our symbol BEFORE reading any data.
  // EXACT bare-symbol match (assertBareSymbolMatch) — "BA" must not pass as
  // "BABA" / "BA.L" / "BIST:BA". FAIL-CLOSED: bridge null donerse de abort
  // (eski `if (preBare && ...)` formu null'da guard'i atliyordu).
  const bareExpected = bareSymbol.toUpperCase();
  const preBare = await bridge.getCurrentBareSymbol().catch(() => null);
  const preCheck = assertBareSymbolMatch(preBare, bareExpected);
  if (!preCheck.ok) {
    console.log(`[Scanner] ${symbol} TF${tf}: ${preCheck.reason} — yeniden degistiriliyor`);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    await sleep(4000);
    const recheck = await bridge.getCurrentBareSymbol().catch(() => null);
    const recheckRes = assertBareSymbolMatch(recheck, bareExpected);
    if (!recheckRes.ok) {
      throw chartSymbolMismatch(symbol, tf, recheckRes.reason);
    }
  }

  return { chartSymbol, bareExpected };
}

/**
 * Scan a single timeframe for short-term data (KhanSaab + SMC).
 * Returns raw collected data for that TF.
 */
async function collectShortTermData(symbol, tf) {
  // Patch 6 — uc katmanli orchestration:
  //   1. ensureChartReady: chart'i istenen sembol/TF'ye getir + pre-read verify
  //   2. gatherRawBundle: raw veri (quote + OHLCV + study + SMC) + post-read +
  //      deviation retry
  //   3. enrichBundle: saf hesaplama (calculator + parser + shadow)
  const ctx = await ensureChartReady(symbol, tf);
  const raw = await gatherRawBundle(symbol, tf, ctx);
  return enrichBundle({ symbol, tf, ...raw });
}

/**
 * Patch 6 — adım 3: Raw veri toplama katmanı.
 *
 * Sorumluluk: chart hazır iken (ensureChartReady sonrası) raw verileri çek;
 * symbol mismatch + stale + deviation guard'larını uygula; sembol kontaminasyon
 * şüphesinde throw et. Saf değildir — bridge çağrıları içerir.
 *
 * Dönüş: { ohlcvData, studyValues, smc, quotePrice }. enrichBundle bunları
 * tüketir.
 */
async function gatherRawBundle(symbol, tf, ctx) {
  const { chartSymbol, bareExpected } = ctx;

  // Get quote price first for validation (independent of TF) — guard with expectedSymbol
  const quotePrice = await bridge.getQuote(chartSymbol).then(q => (q && !q._symbolMismatch ? q.close : null)).catch(() => null);

  let [ohlcvData, studyValues, smc] = await Promise.all([
    bridge.getOhlcvValidated(100, tf, chartSymbol).catch(() => null),
    bridge.getStudyValues().catch(() => null),
    bridge.readSMC().catch(() => ({ labels: null, boxes: null, lines: null })),
  ]);

  // Guard: if OHLCV reported a symbol mismatch, abort — do NOT use contaminated bars
  if (ohlcvData && ohlcvData.symbolMismatch) {
    throw ohlcvContaminated(symbol, tf, ohlcvData._expected, ohlcvData._got);
  }

  // If OHLCV is stale (last bar too old for this TF), retry once — sonra ABORT.
  // Bayat veri FATAL: donmus bir chart (orn. sembol switch sonrasi veri akisi
  // ilerlemedi) hem getOhlcv hem getQuote'a ayni eski bari dondurur. getQuote
  // ve getOhlcv ayni mainSeries().bars() koleksiyonunu okudugu icin sapma
  // guard'i (asagida) bu durumu yakalayamaz — deviation daima ~0. Stale veriyle
  // tarama suren eski davranis, 15-Mayis BTCUSD sinyalinin 1-Mayis mumundan
  // entry almasina yol acti. Stale veri ile sinyal uretilmez.
  if (ohlcvData?.stale) {
    console.log(`[Scanner] ${symbol} TF${tf}: Bar verisi stale (yas: ${ohlcvData.lastBarAge}s) — 3s bekleyip yeniden yukluyor`);
    await sleep(3000);
    ohlcvData = await bridge.getOhlcvValidated(100, tf, chartSymbol).catch(() => ohlcvData);
    if (ohlcvData?.stale) {
      throw ohlcvStale(symbol, tf, ohlcvData.lastBarAge, { retry: true });
    }
  }

  // POST-READ: Verify chart symbol AGAIN — fail-closed (bridge null'i guard
  // atlamasin; collectShortTermData sinyal uretim path'i, en agir guard sart).
  const postBare = await bridge.getCurrentBareSymbol().catch(() => null);
  const postCheck = assertBareSymbolMatch(postBare, bareExpected);
  if (!postCheck.ok) {
    throw chartSymbolMismatch(symbol, tf, postCheck.reason, { postRead: true });
  }

  // Validate OHLCV matches current symbol (compare against quote price)
  // Category-based deviation threshold: crypto/commodities %8, stocks/forex %5
  const _catBoost = getCategorySLBoost(symbol);
  const maxDeviation = _catBoost >= 1.15 ? 0.08 : 0.05;

  if (ohlcvData && ohlcvData.bars && ohlcvData.bars.length > 0 && quotePrice && quotePrice > 0) {
    const lastClose = ohlcvData.bars[ohlcvData.bars.length - 1].close;
    const deviation = Math.abs(lastClose - quotePrice) / quotePrice;
    if (deviation > maxDeviation) {
      // OHLCV data likely stale or for wrong symbol — retry with validated fetch
      console.log(`[Scanner] ${symbol} TF${tf}: OHLCV sapma %${(deviation * 100).toFixed(1)} > esik %${(maxDeviation * 100).toFixed(0)} (bar: ${lastClose}, quote: ${quotePrice}) — yeniden yukluyor`);
      await sleep(4000);
      // Retry path MUST also pass chartSymbol — aksi halde getOhlcvValidated
      // symbol-mismatch guardini ATLAR ve onceki sembolden gelen barlari
      // 'gecerli' kabul edebilir (collectShortTermData ana cagrisi gibi).
      const retryOhlcv = await bridge.getOhlcvValidated(100, tf, chartSymbol).catch(() => null);
      if (retryOhlcv?.symbolMismatch) {
        throw ohlcvContaminated(symbol, tf, retryOhlcv._expected, retryOhlcv._got, { retry: true });
      }
      if (retryOhlcv?.bars?.length > 0) {
        const retryClose = retryOhlcv.bars[retryOhlcv.bars.length - 1].close;
        const retryDev = Math.abs(retryClose - quotePrice) / quotePrice;
        if (retryDev < maxDeviation) {
          // Tam swap: bars + total_bars + stale + lastBarAge + lastBarTimestamp
          // hepsi retry'nin guncel degerleriyle gelir. Onceki mutation davranisi
          // sadece bars/total_bars'i overwrite edip stale/lastBarAge alanlarini
          // eskimis halde birakiyordu — downstream learning/grader yanilirdi.
          ohlcvData = mergeDeviationRetry(ohlcvData, retryOhlcv);
        } else if (retryOhlcv.stale) {
          throw ohlcvStale(symbol, tf, retryOhlcv.lastBarAge, { withDeviation: true, deviationPct: retryDev * 100 });
        } else {
          throw ohlcvDeviation(symbol, tf, retryClose, quotePrice, retryDev * 100);
        }
      }
    }
  }

  return { ohlcvData, studyValues, smc, quotePrice };
}

/**
 * Patch 6 — Enrichment katmani (saf, bridge bagimsiz).
 *
 * Inputs:
 *   - symbol, tf (context)
 *   - ohlcvData (raw OHLCV bundle from bridge)
 *   - studyValues (raw study response)
 *   - smc (raw SMC: { labels, boxes, lines })
 *   - quotePrice (number)
 *
 * Output: collectShortTermData'nin orijinal donus sekli.
 *
 * Async: _computeShadowPrimitives icindeki loadFibCache disk I/O yapiyor;
 * bu yuzden fonksiyon async (ama bridge cagrisi yok).
 */
export async function enrichBundle({ symbol, tf, ohlcvData, studyValues, smc, quotePrice }) {
  const bars = ohlcvData?.bars || [];
  const smcSafe = smc || { labels: null, boxes: null, lines: null };

  // Risk #5 — Parser kirilma korumasi: parse sonrasi sema dogrulamasi.
  // 'broken' (>=50% required eksik) → null doner, mevcut akis BEKLE'ye duser.
  // 'partial' → veri gecer ama parser_alarm log dusturulur.
  const parsedKS = gateTechnicals(calcTechnicals(bars), { symbol, timeframe: tf });
  const parsedSMC = gateSMC(parseSMCLabels(smcSafe.labels), { symbol, timeframe: tf });
  // ATR-aware FVG/OB ayrimi icin atr ge geçir (parsedKS.atr veya KhanSaab study).
  const _atrForBoxes = parsedKS?.atr != null ? parsedKS.atr : parseFloat(extractATRFromStudy(studyValues));
  const parsedBoxes = parseSMCBoxes(smcSafe.boxes, { atr: isFinite(_atrForBoxes) ? _atrForBoxes : null });
  const parsedSRLines = parseSMCLines(smcSafe.lines);

  const formation = detectFormations(bars, { timeframe: tf });
  const volConfirm = checkVolumeConfirmation(bars);
  const rsiVal = parsedKS?.rsi || extractRSIFromStudy(studyValues);
  const divergence = detectRSIDivergence(bars, rsiVal);
  const atrVal = extractATRFromStudy(studyValues);
  const squeeze = detectSqueeze(bars, atrVal);
  const cdv = analyzeCDV(bars);

  const emaValue = parsedKS?.ema21 || extractEMAFromStudy(studyValues) || null;
  const stochRSI = calculateStochRSI(bars, { emaValue });

  // Patch 2 — shadow-only primitives. Hesaplanir ama tallyVotes'a gitmez;
  // gradeShortTermSignal bu alanlari result.shadowMetrics + result.shadowVotes
  // olarak surface eder. Hata/null durumunda alan sessizce eksik kalir.
  const shadow = await _computeShadowPrimitives({ symbol, tf, bars, parsedKS, parsedSMC, parsedBoxes, quotePrice });

  return {
    tf,
    ohlcv: ohlcvData,
    studyValues,
    khanSaab: parsedKS,
    smc: parsedSMC,
    rawSMC: smcSafe,
    parsedBoxes,
    smcSRLines: parsedSRLines,
    khanSaabLabels: null,
    quotePrice,
    formation,
    volConfirm,
    divergence,
    squeeze,
    cdv,
    stochRSI,
    bars,
    shadow,
  };
}

// ---------------------------------------------------------------------------
// Patch 2 helper — shadow primitives. Live decision path does NOT consume any
// of these; gradeShortTermSignal only attaches them to the output.
// ---------------------------------------------------------------------------
async function _computeShadowPrimitives({ symbol, tf, bars, parsedKS, parsedSMC, parsedBoxes, quotePrice }) {
  const out = {
    rsiSeries: null,
    cmf: null,
    mfi: null,             // { prev, cur }
    maStack: null,         // requires 200+ bars (opportunistic fetch)
    maCross: null,         // requires 201+ bars
    macdExt: null,
    rsiThresholdCross: null,
    rsiFailureSwing: null,
    mitigatedZones: null,  // { orderBlocks, fvgZones } with mitigation tags
    cleanBOSstatus: null,  // 'BOS' | 'liquidity_grab' | null (heuristic: last bar vs lastBOS price)
    liquidityBias: null,
    strongPivotBias: null,
    fibCluster: null,
    goldenZone: null,
    fetched250: false,
  };

  // RSI series for Swanson detectors. calcRSIArray is module-private; rebuild
  // a 14-period RSI from closes inline (Wilder smoothing matches calcRSIArray).
  try {
    const closes = bars.map(b => b.close);
    if (closes.length >= 16) {
      const period = 14;
      let g = 0, l = 0;
      for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) g += d; else l -= d;
      }
      let avgG = g / period, avgL = l / period;
      const rsi = new Array(period).fill(null);
      rsi.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
      for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
        avgG = (avgG * (period - 1) + up) / period;
        avgL = (avgL * (period - 1) + dn) / period;
        rsi.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
      }
      out.rsiSeries = rsi.filter(v => v != null);
    }
  } catch (e) { recordShadowDrop('shadow_features', `rsiSeries: ${e?.message}`); }

  out.cmf = calcCMF(bars, 20);
  const mfiCur  = calcMFI(bars, 14);
  const mfiPrev = calcMFI(bars.slice(0, -1), 14);
  if (mfiCur != null || mfiPrev != null) out.mfi = { prev: mfiPrev, cur: mfiCur };

  out.macdExt = calcMACDExtended(bars, 12, 26, 9);

  if (out.rsiSeries) {
    const adxN = parsedKS?.adx != null ? Number(parsedKS.adx) : null;
    const trending = Number.isFinite(adxN) && adxN > 25;
    out.rsiThresholdCross = detectRsiThresholdCross(out.rsiSeries, { trending });
    out.rsiFailureSwing   = detectRsiFailureSwing(out.rsiSeries);
  }

  // Mitigation tagging on parsed zones (parsedBoxes have no barIndex today,
  // so tagMitigation falls back to scanning all bars — gives a useful flag for
  // the most-recent zones that were touched).
  if (parsedBoxes && (parsedBoxes.orderBlocks?.length || parsedBoxes.fvgZones?.length)) {
    out.mitigatedZones = {
      orderBlocks: tagMitigation(parsedBoxes.orderBlocks || [], bars),
      fvgZones:    tagMitigation(parsedBoxes.fvgZones    || [], bars),
    };
  }

  // King p.55 — clean-BOS heuristic: classify the last bar's relationship to
  // the most recent BOS level (if any).
  if (parsedSMC?.lastBOS && Number.isFinite(parsedSMC.lastBOS.price) && bars.length >= 1) {
    const last = bars[bars.length - 1];
    const dir = parsedSMC.lastBOS.direction === 'bullish' ? 'up'
              : parsedSMC.lastBOS.direction === 'bearish' ? 'down' : null;
    if (dir) out.cleanBOSstatus = classifyCleanBreak(last, parsedSMC.lastBOS.price, dir);
  }

  if (parsedSMC) {
    out.liquidityBias    = deriveLiquidityBias(parsedSMC.eqh, parsedSMC.eql, quotePrice);
    out.strongPivotBias  = deriveStrongPivotBias(parsedSMC.strongHigh, parsedSMC.strongLow);
  }

  // Boroden — fib cluster + golden zone. Reads existing HTF cache only.
  try {
    const fibCache = loadFibCache(symbol);
    if (fibCache) {
      out.fibCluster = findFibCluster(quotePrice, fibCache, 0.003);
      out.goldenZone = priceInGoldenZone(quotePrice, fibCache);
    }
  } catch (e) { recordShadowDrop('fib', e?.message || 'cache absent'); }

  // 200-bar fetch is intentionally NOT performed inside collectShortTermData
  // (the chart lock is held; an extra fetch would add latency to every TF).
  // calcMAStack/calcMACross attempt with what we have; if bars.length < 200
  // they return null and the field is silently absent. The opportunistic
  // 250-bar fetch is performed once per scan (after all TF data is gathered)
  // in _scanShortTermInner; results are merged into bestSignal.shadow.
  out.maStack = calcMAStack(bars);
  out.maCross = calcMACross(bars);

  return out;
}

/**
 * Scan a single timeframe for long-term data (Supertrend + IFCCI).
 */
async function collectLongTermData(symbol, tf) {
  const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const chartSymbol = resolveChartSymbol(symbol);

  // Pre-switch snapshot — collectShortTermData ile ayni kirletme tuzagi (bkz.
  // 2026-05-23 bug): chart.symbol() istenen sembolu aninda dondurur ama bars
  // hala onceki sembolun verisini tutuyor olabilir. HTF tarama da ayni fatal
  // veriyi okur, dolayisiyla data-change guard'i burada da gerekli.
  const prevSnapshot = await bridge.getBarSnapshot().catch(() => null);

  const symResult = await bridge.setSymbol(chartSymbol);
  if (symResult.success === false) {
    throw symbolSwitchFailed(symbol, chartSymbol);
  }
  await bridge.setTimeframe(tf);

  let dataChangeResult = await bridge.waitForDataChange(prevSnapshot, 10000);
  if (!dataChangeResult.changed) {
    console.log(`[Scanner] ${symbol} TF${tf} (LTF): Bar verisi degismedi (10s) — setSymbol yeniden deneniyor`);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    dataChangeResult = await bridge.waitForDataChange(prevSnapshot, 10000);
    if (!dataChangeResult.changed) {
      throw barDataTimeout(symbol, tf, true);
    }
  }

  // Exact bare-symbol verification — fail-closed (bkz. assertBareSymbolMatch).
  const bareExpected = bareSymbol.toUpperCase();
  const preBare = await bridge.getCurrentBareSymbol().catch(() => null);
  const preCheck = assertBareSymbolMatch(preBare, bareExpected);
  if (!preCheck.ok) {
    console.log(`[Scanner] ${symbol} TF${tf} (LTF): ${preCheck.reason} — retry`);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    await sleep(4000);
    const recheck = await bridge.getCurrentBareSymbol().catch(() => null);
    const recheckRes = assertBareSymbolMatch(recheck, bareExpected);
    if (!recheckRes.ok) {
      throw chartSymbolMismatch(symbol, tf, recheckRes.reason, { ltf: true });
    }
  }

  const [ohlcvData, studyValues] = await Promise.all([
    bridge.getOhlcvValidated(100, tf, chartSymbol).catch(() => null),
    bridge.getStudyValues().catch(() => null),
  ]);

  // Hem validated symbolMismatch hem ham _symbolMismatch'i kabul et (bridge ikisini
  // de set ediyor; collectShortTermData ile aynı konvansiyon).
  if (ohlcvData && (ohlcvData.symbolMismatch || ohlcvData._symbolMismatch)) {
    throw ohlcvContaminated(symbol, tf, ohlcvData._expected, ohlcvData._got, { ltf: true });
  }

  // Bayat veri fatal — donmus chart HTF baglamini da kirletir (bkz. HTF scan).
  if (ohlcvData?.stale) {
    throw ohlcvStale(symbol, tf, ohlcvData.lastBarAge, { ltf: true });
  }

  // Post-read verification — fail-closed.
  const postBare = await bridge.getCurrentBareSymbol().catch(() => null);
  const postCheck = assertBareSymbolMatch(postBare, bareExpected);
  if (!postCheck.ok) {
    throw chartSymbolMismatch(symbol, tf, postCheck.reason, { ltf: true, postRead: true });
  }

  const bars = ohlcvData?.bars || [];
  const formation = detectFormations(bars, { timeframe: tf });

  return { tf, ohlcv: ohlcvData, studyValues, formation, bars };
}

/**
 * Quick trend check on a higher TF — only reads study values + EMA direction.
 * Returns { direction: 'long'|'short'|'neutral', confidence, reasoning }
 */
async function quickTrendCheck(symbol, tf) {
  try {
    const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    const bareExpected = bareSymbol.toUpperCase();
    const chartSymbol = resolveChartSymbol(symbol);

    // collectShortTermData ile ayni kirletme tuzagi (bkz. 2026-05-23 bug):
    // chart.symbol() yeni adi aninda donebilir ama bars onceki sembolden olabilir.
    // setSymbol + setTimeframe sonrasi bar verisinin DEGISTIGINI dogrula.
    const prevSnapshot = await bridge.getBarSnapshot().catch(() => null);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    const changed = await bridge.waitForDataChange(prevSnapshot, 8000).catch(() => ({ changed: false }));
    if (!changed?.changed) {
      return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} bar verisi degismedi — trend okunamadi`] };
    }

    // EXACT bare-symbol match (assertBareSymbolMatch) — "BA" "BABA"/"BIST:BA"
    // gibi sembollerle eslesmemeli; aksi halde yanlis trend yonu okunur.
    const currentBare = await bridge.getCurrentBareSymbol().catch(() => null);
    const check = assertBareSymbolMatch(currentBare, bareExpected);
    if (!check.ok) {
      return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} sembol dogrulanamadi: ${check.reason}`] };
    }

    // Validated OHLCV: hem stale hem symbol-mismatch guard'i. Wrong-symbol veya
    // donmus bar trend kararini yanlis taraftan onaylar — bu trend hard veto
    // olarak signal grade'ini etkiliyor, bu yuzden guvenilir veri sart.
    const ohlcvData = await bridge.getOhlcvValidated(100, tf, chartSymbol).catch(() => null);
    if (ohlcvData?.symbolMismatch || ohlcvData?.stale) {
      const why = ohlcvData?.symbolMismatch ? 'sembol uyumsuz' : `stale (yas=${ohlcvData.lastBarAge}s)`;
      return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} trend verisi guvenilmez (${why})`] };
    }
    const bars = ohlcvData?.bars || [];
    const parsedKS = calcTechnicals(bars);
    let longVotes = 0, shortVotes = 0;
    const reasons = [];

    // EMA direction
    if (parsedKS?.emaStatus === 'BULL') { longVotes += 2; reasons.push(`${tfLabel(tf)} EMA BULL`); }
    else if (parsedKS?.emaStatus === 'BEAR') { shortVotes += 2; reasons.push(`${tfLabel(tf)} EMA BEAR`); }

    // MACD direction
    if (parsedKS?.macd === 'BULL') { longVotes += 1; reasons.push(`${tfLabel(tf)} MACD BULL`); }
    else if (parsedKS?.macd === 'BEAR') { shortVotes += 1; reasons.push(`${tfLabel(tf)} MACD BEAR`); }

    const total = longVotes + shortVotes;
    if (total === 0) return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} trend belirsiz`] };

    const direction = longVotes > shortVotes ? 'long' : longVotes < shortVotes ? 'short' : 'neutral';
    const confidence = total > 0 ? Math.max(longVotes, shortVotes) / total : 0;
    return { direction, confidence: Math.round(confidence * 100), reasoning: reasons };
  } catch {
    return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} trend okunamadi`] };
  }
}

/**
 * Short-term MULTI-TIMEFRAME scan for a single symbol.
 *
 * KhanSaab approach:
 *   Phase 1: Quick trend check on 4H + 1H (establish direction)
 *   Phase 2: Full scan on asset-specific execution TFs (5m/15m/30m)
 *   Phase 3: Grade each TF, apply trend filter, pick best signal
 */
export async function scanShortTerm(symbol, options = {}) {
  return withScanLifecycle(`short:${symbol}`, () => _scanShortTermInner(symbol, options));
}

async function _scanShortTermInner(symbol, options = {}) {
  const singleTF = options.singleTF;
  const execTFs = options.timeframes || getExecTFs(symbol);
  const tfsToScan = singleTF ? [singleTF] : execTFs;
  const category = getAssetCategory(symbol);
  const abortCheck = options.abortCheck || (() => false);

  // --- HTF fib cache gate (2026-05-22) ---
  // Bir sembolde HTF fib cache eksik/bayatsa, sinyal acilmadan ONCE on-demand
  // fib taramasi yapilir + cache yazilir; ardindan normal tarama taze cache'i
  // okur. Refresh basarisizsa (TV baglantisi yok / yeterli HTF bar yok) bu
  // sembolde GERCEK sinyal acilmaz: fibGateBlocked=true ile bestSignal asagida
  // BEKLE'ye dusurulur. Scan lock cagiran (scanShortTerm/batchScan) tarafindan
  // tutuluyor; refreshHTFFibForSymbol lock almaz.
  let fibGateBlocked = false;
  let fibGateReason = null;
  if (!options.skipFibGate) {
    try {
      const _age = checkFibCacheAge(loadFibCache(symbol));
      if (_age.missing || _age.stale) {
        const ageLabel = _age.missing ? 'YOK' : `${_age.ageHours}h`;
        console.log(`[Scanner] ${symbol}: HTF fib cache ${ageLabel} — on-demand refresh (sinyal bekletiliyor)`);
        const fib = await refreshHTFFibForSymbol(symbol, category);
        if (fib.ok) {
          console.log(`[Scanner] ${symbol}: HTF fib cache tazelendi (on-demand)`);
        } else {
          fibGateBlocked = true;
          fibGateReason = `HTF fib refresh basarisiz (${fib.reason}) — eksiklik giderilemedi, sinyal acilmadi`;
          console.log(`[Scanner] ${symbol}: ${fibGateReason}`);
        }
      }
    } catch (e) {
      fibGateBlocked = true;
      fibGateReason = `HTF fib refresh hata: ${e.message} — sinyal acilmadi`;
      console.log(`[Scanner] ${symbol}: ${fibGateReason}`);
    }
  }

  const tfResults = {};
  const tfSignals = [];

  // Setup indicators (check KhanSaab + SMC are present)
  let indicatorSetup;
  try {
    indicatorSetup = await bridge.setupIndicatorsForScan('short');
  } catch { indicatorSetup = { warnings: [] }; }

  // --- Phase 1: Quick trend check on higher TFs (asset-specific) ---
  const assetTrendTFs = getTrendTFs(symbol);
  let higherTFTrend = null;
  if (!singleTF) {
    const trendResults = [];
    for (const trendTF of assetTrendTFs) {
      if (abortCheck()) { console.log(`[Scanner] ${symbol} trend taramasi iptal edildi`); break; }
      const trend = await quickTrendCheck(symbol, trendTF);
      trendResults.push({ tf: trendTF, ...trend });
    }

    // Aggregate trend direction from higher TFs
    const longTrend = trendResults.filter(t => t.direction === 'long').length;
    const shortTrend = trendResults.filter(t => t.direction === 'short').length;
    const avgConfidence = trendResults.length > 0 ? trendResults.reduce((s, t) => s + t.confidence, 0) / trendResults.length : 0;

    if (longTrend > shortTrend) {
      higherTFTrend = { direction: 'long', confidence: Math.round(avgConfidence), details: trendResults };
    } else if (shortTrend > longTrend) {
      higherTFTrend = { direction: 'short', confidence: Math.round(avgConfidence), details: trendResults };
    } else {
      higherTFTrend = { direction: 'neutral', confidence: 0, details: trendResults };
    }
  }

  // --- Phase 2: Full scan on execution TFs ---
  for (const tf of tfsToScan) {
    if (abortCheck()) { console.log(`[Scanner] ${symbol} exec taramasi iptal edildi`); break; }
    try {
      const data = await collectShortTermData(symbol, tf);
      tfResults[tf] = data;
    } catch (e) {
      tfResults[tf] = { tf, error: e.message };
    }
  }

  // Get macro filter (once for all TFs) — alreadyLocked: scanShortTerm holds the chart lock
  let macroState;
  try { macroState = await getMacroState(false, true); } catch { macroState = null; }

  // --- Phase 3: Grade each execution TF ---
  for (const tf of tfsToScan) {
    const data = tfResults[tf];
    if (!data || data.error) {
      tfSignals.push({ tf, grade: 'HATA', error: data?.error || 'Veri alinamadi' });
      continue;
    }

    const ks = data.khanSaab;
    const direction = (ks?.emaStatus === 'BULL' && ks?.macd === 'BULL') ? 'long'
      : (ks?.emaStatus === 'BEAR' && ks?.macd === 'BEAR') ? 'short'
      : 'long';
    const macroFilter = macroState ? applyMacroFilter(macroState, symbol, direction) : null;
    // 2026-05-02 — `Number(x) || null` ADX=0 (flat market) durumunu null'a duruyordu;
    // bu null compute-regime'e gidip low_vol_drift veya grey_zone'a kayiyordu.
    // Number.isFinite ile gercek null ayrimi yap.
    const _adxRaw = Number(data.khanSaab?.adx);
    const adxForRegime = Number.isFinite(_adxRaw) ? _adxRaw : null;
    // Legacy 5-rejim — shadow hesaplama düşerse fallback olarak korunur.
    const regimeResult = classifyRegime(macroState || {}, adxForRegime);
    const legacyRegime = regimeResult?.regime || 'neutral';

    // ====================================================================
    // computeRegime() — Faz 1 shadow logger + Faz 2 wrapper kaynagı.
    // Sonuc:
    //   1. JSONL'e log dusurulur (Faz 1 ara rapor icin)
    //   2. regimeContext olarak gradeShortTermSignal'a verilir (Faz 2 wrapper)
    // Hata olursa shadowComputeOk=false, ana akis null regimeContext ile
    // devam eder (eski davranis korunur).
    // ====================================================================
    let shadowResult = null;
    let shadowMarketType = null;
    try {
      // Faz 2 v2.2 — ADX slope hesabı (3-bar fark, normalize edilmemiş).
      // Pozitif = ADX yükseliyor (trend güçleniyor), negatif = düşüyor (zayıflıyor).
      // computeRegime trending teşhisinde `adxSlope >= 0` koşulu kullanır.
      const adxSeries = data.khanSaab?.adxSeries;
      let adxSlope = 0;
      let adxSlopeKnown = false;
      if (Array.isArray(adxSeries) && adxSeries.length >= 3) {
        const a = adxSeries[adxSeries.length - 1];
        const b = adxSeries[adxSeries.length - 3];
        if (Number.isFinite(a) && Number.isFinite(b)) {
          adxSlope = (a - b) / 3;
          adxSlopeKnown = true;
        }
      }
      // ADX yon: rising / falling / flat. Slope mutlak < 0.5/bar ise flat
      // (ADX 0-100 araliginda — 0.5/bar gurultuden ayirt edilemez).
      const adxDirection = !adxSlopeKnown
        ? null
        : (Math.abs(adxSlope) < 0.5 ? 'flat' : (adxSlope > 0 ? 'rising' : 'falling'));
      // Snapshot/grader'in adxSlope/adxDirection okuyabilmesi icin khanSaab'a yaz.
      if (data.khanSaab && typeof data.khanSaab === 'object') {
        data.khanSaab.adxSlope = adxSlopeKnown ? Number(adxSlope.toFixed(3)) : null;
        data.khanSaab.adxDirection = adxDirection;
      }
      // 2026-05-02 — Once chart study'lerinden cek; yoksa OHLCV'dan yerel hesapla.
      // Daha onceki kod yalniz `data.studyValues?.ema20` okuyordu — bu raw study
      // dizisinde duz field olmadigi icin daima null donuyordu. Klasifiye edici
      // priceAboveEma20=null + bbWidthRatio=null alinca grey_zone uzerinden hep
      // 'ranging' uretiyordu. Burada extractor + bars-fallback ile gercek deger
      // saglaniyor; chart'ta BB/EMA20 study'si olmasa da rejim islerlik kazanir.
      let ema20Val = extractEMA20FromStudy(data.studyValues);
      let bb = extractBBFromStudy(data.studyValues);
      if (ema20Val == null && Array.isArray(data.bars) && data.bars.length >= 20) {
        ema20Val = computeEMA20FromBars(data.bars);
      }
      if ((bb.upper == null || bb.lower == null || bb.basis == null) &&
          Array.isArray(data.bars) && data.bars.length >= 20) {
        bb = computeBBFromBars(data.bars, 20, 2);
      }
      const studyValuesForRegime = {
        adx: adxForRegime,
        adxSlope,
        ema20: ema20Val,
        bbUpper: bb.upper,
        bbLower: bb.lower,
        bbBasis: bb.basis,
      };
      const macroForRegime = {
        vix: (() => { const v = Number(macroState?.['VIX']?.value); return Number.isFinite(v) ? v : null; })(),
        funding_rate: data.funding ?? null,
        usdtry_realized_sigma_5d: macroState?.usdtry_sigma_5d ?? null,
        usdtry_bist_rho_5d: macroState?.usdtry_bist_rho_5d ?? null,
        usdtry_return_1d: macroState?.usdtry_return_1d ?? null,
      };
      shadowMarketType = _shadowCategoryToMarketType(category);
      // 2026-05-02 — `data.ohlcv` bir obje ({bars,total_bars,...}); compute-regime
      // bars array bekliyor. Eski `Array.isArray(data.ohlcv)` her zaman false →
      // klasifiye edici last bar bulamaz → priceAboveEma20=null → grey_zone →
      // 'ranging'. Dogru bars kaynagi `data.bars` (collectShortTermData ciktisi).
      shadowResult = _shadowComputeRegime({
        symbol, timeframe: String(tf), marketType: shadowMarketType,
        ohlcv: Array.isArray(data.bars) ? data.bars : (Array.isArray(data.ohlcv?.bars) ? data.ohlcv.bars : []),
        studyValues: studyValuesForRegime,
        macro: macroForRegime,
        chaosWindows: {},
        events: [],
        session: null,
        now: Date.now(),
      });
      _shadowLogRegime({
        symbol, timeframe: String(tf), marketType: shadowMarketType,
        result: shadowResult, now: Date.now(),
      });
    } catch (shadowErr) {
      shadowResult = null;
      console.warn(`[shadow-regime] ${symbol}/${tf} hesaplama/log hatasi: ${shadowErr?.message || shadowErr}`);
      recordShadowDrop('regime', shadowErr?.message);
    }

    // Faz 2 wrapper icin regimeContext sozlesmesi
    const regimeContextForGrader = shadowResult ? {
      regime: shadowResult.regime,
      subRegime: shadowResult.subRegime,
      strategyHint: shadowResult.strategyHint,
      confidence: shadowResult.confidence,
      newPositionAllowed: shadowResult.newPositionAllowed,
      unstable: shadowResult.unstable,
      stableBars: shadowResult.stableBars,
      transitioned: shadowResult.transitioned,
    } : null;

    // Faz 2 Commit 4 — kanonik regime alanı yeni 6-rejim taxonomy'sine geçti.
    // weight-adjuster.REGIMES_TRACKED ile aynı anahtar uzayı kullanılıyor;
    // shadowResult.regime varsa o, yoksa legacy fallback.
    const regime = shadowResult?.regime || legacyRegime;

    // Trendline hesabi — shadowMarketType burada cozulu (collectShortTermData
    // icinde marketType henuz yok). Advisory; grade'i etkilemez.
    const trendlines = calculateTrendlines({
      bars: data.bars,
      timeframe: tf,
      marketType: shadowMarketType,
      symbol,
    });

    const graderInput = {
      khanSaab: data.khanSaab,
      smc: data.smc,
      studyValues: data.studyValues,
      ohlcv: data.ohlcv,
      formation: data.formation,
      squeeze: data.squeeze,
      divergence: data.divergence,
      cdv: data.cdv,
      stochRSI: data.stochRSI,
      macroFilter,
      symbol,
      timeframe: tf,
      // Smart entry support
      quotePrice: data.quotePrice,
      parsedBoxes: data.parsedBoxes,
      smcSRLines: data.smcSRLines,
      khanSaabLabels: data.khanSaabLabels,
      regime,
      // Faz 2 Commit 3 — wrapper'a regimeContext + marketType geçir
      regimeContext: regimeContextForGrader,
      marketType: shadowMarketType,
      htfConfidence: higherTFTrend?.confidence ?? null,
      // mtfAlignment Faz 2 Commit 4'te alignment-filters'tan beslenecek; şimdilik null
      mtfAlignment: null,
      // Patch 2 — shadow primitives. Grader bunlari result.shadowMetrics +
      // result.shadowVotes olarak surface eder; tallyVotes'a girmez.
      shadow: data.shadow || null,
      // Trendline advisory context — grade'e katki yok, sadece reasoning/warnings.
      trendlines,
    };

    const signal = gradeShortTermSignal(graderInput);
    signal.regime = regime;

    // Apply higher-TF trend filter (KhanSaab: "First check trend on big TF")
    // HARD VETO: counter-trend + HTF confidence >= 60 → BEKLE (no entry)
    if (higherTFTrend && higherTFTrend.direction !== 'neutral' && signal.direction) {
      if (signal.direction === higherTFTrend.direction) {
        signal.reasoning = signal.reasoning || [];
        signal.reasoning.push(`Yuksek TF trend UYUMLU (${higherTFTrend.direction.toUpperCase()}, guven: %${higherTFTrend.confidence}) — sinyal guclendi`);
        if (signal.tally) signal.tally.conviction = Math.round(signal.tally.conviction * 1.15 * 100) / 100;
      } else {
        signal.reasoning = signal.reasoning || [];
        signal.reasoning.push(`UYARI: Sinyal yuksek TF trendine KARSI (trend: ${higherTFTrend.direction.toUpperCase()}, guven: %${higherTFTrend.confidence})`);
        signal.warnings = signal.warnings || [];
        signal.warnings.push(`Yuksek TF trend ${higherTFTrend.direction.toUpperCase()}, sinyal ${signal.direction.toUpperCase()} — celiskili`);
        // 2026-05-03: HTF VETO kaldırıldı. Karşı-trend bilgi olarak reasoning'e yazılır,
        // grade liga sistemine + R:R/sanity filtrelerine bırakılır. Conviction yine kırpılır.
        // 2026-05-16 PROMOTE: 14-gun korelasyonda HTF counter-trend (guven>=60) triggered
        // WR=%33.3 vs untriggered %61 → Δ=-27.7%. Conviction*0.75 kirpilmasi yetmiyor;
        // grade'i 1 kademe DAHA DUSUR.
        if ((higherTFTrend.confidence || 0) >= 60) {
          if (signal.tally) signal.tally.conviction = Math.round(signal.tally.conviction * 0.75 * 100) / 100;
          if (signal.grade && ['A', 'B', 'C'].includes(signal.grade)) {
            const _newGrade = signal.grade === 'A' ? 'B' : signal.grade === 'B' ? 'C' : 'BEKLE';
            signal.reasoning.push(`HTF counter-trend (guven ≥%60) → grade ${signal.grade}→${_newGrade} dusuruldu (gozlemsel WR -27.7%, n=9)`);
            signal.grade = _newGrade;
          } else {
            signal.reasoning.push(`HTF counter-trend (guven ≥%60) — conviction kirpildi (grade zaten A/B/C disinda)`);
          }
        } else if (signal.tally) {
          signal.tally.conviction = Math.round(signal.tally.conviction * 0.60 * 100) / 100;
        }
      }
    }

    // --- HTF Gate (2026-05-02): per-TF dinamik teyit ---
    //   4H sinyal → 1D zorunlu, 1W bilgilendirici
    //   1D sinyal → 1D kendisi sinyal; sadece 1W bilgilendirici (sert kapi yok)
    if (signal.direction && signal.grade && !['IPTAL', 'HATA', 'BEKLE'].includes(signal.grade)) {
      const details = higherTFTrend?.details || [];
      const t1d = details.find(t => String(t.tf) === '1D');
      const t1w = details.find(t => String(t.tf) === '1W');
      const dir = signal.direction;
      const isFourHour = String(tf) === '240';
      const isDaily    = String(tf) === '1D';

      signal.reasoning = signal.reasoning || [];
      signal.warnings = signal.warnings || [];

      if (isFourHour) {
        // 2026-05-03: 4H için sert HTF gate kaldırıldı (advisory). Liga + R:R yeterli.
        // 2026-05-16 PROMOTE: 14-gun korelasyonda 4H sinyalde 1D teyidi zayif olunca
        // WR=%50 vs %60.4 (Δ=-10.4%, n=16). Hard BEKLE veto degil ama grade 1 kademe dusur.
        const t1dOk = t1d && t1d.direction === dir && (t1d.confidence || 0) >= 50;
        if (!t1dOk) {
          if (['A', 'B', 'C'].includes(signal.grade)) {
            const _newGrade = signal.grade === 'A' ? 'B' : signal.grade === 'B' ? 'C' : 'BEKLE';
            signal.reasoning.push(`${dir.toUpperCase()} HTF GATE [4H]: 1D=${t1d?.direction || '?'}(%${t1d?.confidence || 0}) → grade ${signal.grade}→${_newGrade} dusuruldu (gozlemsel WR -10.4%, n=16)`);
            signal.warnings.push(`HTF gate: 1D ${dir} teyidi eksik → grade dusuruldu`);
            signal.grade = _newGrade;
          } else {
            signal.reasoning.push(`${dir.toUpperCase()} HTF GATE [4H]: 1D=${t1d?.direction || '?'}(%${t1d?.confidence || 0}) — 1D teyidi zayif (grade zaten A/B/C disinda)`);
            signal.warnings.push(`HTF gate: 1D ${dir} teyidi eksik (advisory)`);
          }
        } else if (t1w && t1w.direction !== dir) {
          signal.warnings.push(`1W trend ${t1w.direction} (${dir} sinyale karsi) — dikkat`);
          signal.reasoning.push(`1W=${t1w.direction}(%${t1w.confidence || 0}) uyumsuz ama 1D teyit etti — gecti`);
        }
      } else if (isDaily) {
        // 1D: kendisi sinyal — sadece 1W bilgilendirici
        if (t1w && t1w.direction === dir) {
          signal.reasoning.push(`1W=${t1w.direction}(%${t1w.confidence || 0}) — 1D sinyali ile uyumlu`);
        } else if (t1w && t1w.direction !== dir && t1w.direction && t1w.direction !== 'neutral') {
          signal.warnings.push(`1W trend ${t1w.direction} (${dir} sinyale karsi) — dikkat`);
          signal.reasoning.push(`1W=${t1w.direction}(%${t1w.confidence || 0}) uyumsuz — bilgilendirici, sert kapi yok`);
        }
      }
    }

    signal.tf = tf;
    signal.tfLabel = tfLabel(tf);
    signal.formations = data.formation?.formations || [];
    signal.candles = data.formation?.candles || [];
    signal.cdv = data.cdv;
    signal.squeeze = data.squeeze;
    signal.divergence = data.divergence;
    signal.volConfirm = data.volConfirm;
    // Ham indikator verisini signal'a iliştir — learning katmanı
    // (signal-tracker.extractIndicatorSnapshot) bu alanları okur.
    // Ilistirilmezse snapshot'taki khanSaab/smc/macro/mtf alanlari null kalir.
    signal.khanSaab = data.khanSaab;
    signal.khanSaabBias = data.khanSaab?.bias || null;
    signal.smc = data.smc;
    signal.macroFilter = macroFilter;
    try {
      recordDecisionSnapshot(buildDecisionSnapshot({
        stage: 'per_tf',
        symbol,
        timeframe: tf,
        mode: 'short',
        graderInput,
        signal,
        context: {
          category,
          higherTFTrend,
          regimeContext: regimeContextForGrader,
          marketType: shadowMarketType,
        },
      }));
    } catch (e) {
      console.warn(`[DecisionSnapshot] ${symbol}/${tf} yazilamadi: ${e.message}`);
      recordShadowDrop('snapshot', e?.message);
    }
    tfSignals.push(signal);
  }

  // Multi-TF confirmation: count how many TFs agree on direction
  const gradeOrder = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3, 'IPTAL': 4, 'HATA': 5 };
  const validSignals = tfSignals.filter(s => s.grade && s.grade !== 'IPTAL' && s.grade !== 'HATA' && s.grade !== 'BEKLE');

  let mtfConfirmation = null;
  if (validSignals.length > 1) {
    const longCount = validSignals.filter(s => s.direction === 'long').length;
    const shortCount = validSignals.filter(s => s.direction === 'short').length;
    const total = validSignals.length;

    if (longCount >= total * 0.75) {
      mtfConfirmation = { direction: 'long', agreement: Math.round(longCount / total * 100), count: longCount, total };
    } else if (shortCount >= total * 0.75) {
      mtfConfirmation = { direction: 'short', agreement: Math.round(shortCount / total * 100), count: shortCount, total };
    } else {
      mtfConfirmation = { direction: 'mixed', agreement: Math.round(Math.max(longCount, shortCount) / total * 100), count: Math.max(longCount, shortCount), total };
    }
  }

  // Pick best signal (lowest grade order = best, conviction as tiebreaker)
  tfSignals.sort((a, b) => {
    const gDiff = (gradeOrder[a.grade] ?? 9) - (gradeOrder[b.grade] ?? 9);
    if (gDiff !== 0) return gDiff;
    // Same grade → prefer higher conviction
    return (b.tally?.conviction || 0) - (a.tally?.conviction || 0);
  });
  const bestSignal = tfSignals[0] || { grade: 'IPTAL', symbol, error: 'Sinyal yok' };

  // --- HTF fib cache gate enforcement (2026-05-22) ---
  // On-demand fib refresh basarisiz olduysa (yukarida fibGateBlocked) bu
  // sembolde GERCEK sinyal acilmasin: tradable grade BEKLE'ye dusurulur,
  // league virtual + position_pct 0 → executor dispatch ve gercek poz yok.
  // Sinyal yine de "tamamlanir" (kart/analitik gorunur) ve scanner sonraki
  // sembole gecer.
  if (fibGateBlocked && bestSignal && ['A', 'B', 'C'].includes(bestSignal.grade)) {
    bestSignal.reasoning = bestSignal.reasoning || [];
    bestSignal.warnings = bestSignal.warnings || [];
    bestSignal.warnings.push(`FIB GATE: ${fibGateReason}`);
    bestSignal.reasoning.push(`--- FIB GATE: ${bestSignal.grade} → BEKLE (HTF fib eksikligi giderilemedi)`);
    bestSignal.grade = 'BEKLE';
    bestSignal.league = 'virtual';
    bestSignal.position_pct = 0;
  }

  // REGIME_GATES kalibrasyonu icin instrumentation (2026-05-12).
  // bestSignal per-TF gradeShortTermSignal cagrisinda mtfAlignment=null aliyordu
  // (mtfConfirmation tum TF'ler grade'lendikten SONRA hesaplaniyor). Burada
  // mtfConfirmation.agreement degerini bestSignal'e post-hoc set ediyoruz ki
  // signal-tracker archive record'a yazabilsin. Davranisa etki etmez.
  if (bestSignal && mtfConfirmation && mtfConfirmation.agreement != null) {
    bestSignal.mtfAlignment = mtfConfirmation.agreement;
  }

  // Apply MTF confirmation: aligned = note, mixed = downgrade, opposed = BEKLE
  if (mtfConfirmation && bestSignal.grade && bestSignal.grade !== 'IPTAL' && bestSignal.grade !== 'HATA') {
    bestSignal.reasoning = bestSignal.reasoning || [];
    if (mtfConfirmation.direction === 'mixed') {
      // 2026-05-03: MTF mixed advisory only — grade düşürülmüyor.
      bestSignal.reasoning.push(`MTF uyumu %75 altinda (${mtfConfirmation.count}/${mtfConfirmation.total}) — advisory (grade korundu)`);
    } else if (mtfConfirmation.direction !== bestSignal.direction) {
      bestSignal.reasoning.push(`MTF ${mtfConfirmation.direction.toUpperCase()} celiskili (sinyal ${bestSignal.direction?.toUpperCase()}) — advisory (grade korundu)`);
    } else {
      bestSignal.reasoning.push(
        `Multi-TF dogrulama: ${mtfConfirmation.count}/${mtfConfirmation.total} TF ${mtfConfirmation.direction.toUpperCase()} yonunde (%${mtfConfirmation.agreement} uyum)`
      );
    }
  }

  // Per-symbol rules — devre disi (Patch 1, 2026-05-02). Eskiden symbolRules
  // (manual + autoFlagged) minGrade / minHtfConfidence / requireMtfAgreement
  // kosulu sagliamayan sinyalleri grade='BEKLE'ye zorluyordu; bu hard gate
  // 12 sembolun cogunu (HYPEUSDT.P, BTC*, ETH*, XAU/XAG, SOL*) sessizce
  // bastiriyordu. Kullaniciya gore hard gate kaldirildi: kural bilgisi
  // reasoning satirinda gosterilir, grade'e dokunulmaz.
  // Sembol-bazli kalite filtreleme weight-adjuster ve rejim wrapper'i
  // uzerinden tabii sekilde yapiliyor.
  try {
    const _w = loadWeights();
    const bareSym = ((symbol || '').includes(':') ? symbol.split(':')[1] : symbol || '').toUpperCase();
    const rules = _w?.symbolRules || {};
    const ruleKey = Object.keys(rules).find(k => bareSym === k || bareSym.startsWith(k));
    const symRule = ruleKey ? rules[ruleKey] : null;
    if (symRule && bestSignal.grade && bestSignal.grade !== 'IPTAL' && bestSignal.grade !== 'HATA') {
      bestSignal.reasoning = bestSignal.reasoning || [];
      const tag = symRule.autoFlagged ? 'autoFlagged' : 'manual';
      const parts = [];
      if (symRule.minGrade != null) parts.push(`minGrade:${symRule.minGrade}`);
      if (symRule.minHtfConfidence != null) parts.push(`minHtfConfidence:${symRule.minHtfConfidence}`);
      if (symRule.requireMtfAgreement != null) parts.push(`requireMtfAgreement:${symRule.requireMtfAgreement}`);
      const reasonStr = symRule.reason ? ` (${symRule.reason})` : '';
      bestSignal.reasoning.push(`[${bareSym}] per-symbol rule (${tag}) advisory only — ${parts.join(' ')}${reasonStr}`);
    }
  } catch (e) {
    // Non-fatal: per-symbol rule loading failed
    console.log(`[Scanner] per-symbol rule okuma hatasi: ${e.message}`);
  }

  // Patch 2 — per-scan MTF score across all collected TFs (shadow only).
  try {
    const mtfScore = computeMtfScore(tfResults);
    if (mtfScore && bestSignal && typeof bestSignal === 'object') {
      bestSignal.shadowMtfScore = mtfScore;
      // If gradeShortTermSignal already populated shadowMetrics for this TF,
      // mirror mtfScore there too so the signal card shows it inline.
      if (bestSignal.shadowMetrics && typeof bestSignal.shadowMetrics === 'object') {
        bestSignal.shadowMetrics.mtfScore = mtfScore;
      }
    }
  } catch (e) { recordShadowDrop('shadow_mtf', e?.message); /* never blocks live decision */ }

  // Attach fundamental snapshot (US equities only; null for other categories).
  // Read-only: does NOT influence votes, grade, RR, direction, or position size.
  try {
    bestSignal.fundamentalSnapshot = buildFundamentalSnapshot({ symbol, category, now: new Date() });
  } catch (e) { bestSignal.fundamentalSnapshot = null; recordShadowDrop('fundamentals', e?.message); }

  // Shadow features — orthogonal telemetry candidates. Computed AFTER the
  // grader result + barrierSummary exist; read-only, no fetch, no shadow-
  // primitive recomputation. NEVER read by grade/direction/tally/rr/entry/sl/
  // tp/position_pct/league/wrapper/scheduler/OKX dispatch.
  try {
    bestSignal.shadowFeatures = computeShadowFeatures(bestSignal, { now: new Date() });
  } catch (e) { bestSignal.shadowFeatures = null; recordShadowDrop('shadow_features', e?.message); }

  try {
    recordDecisionSnapshot(buildDecisionSnapshot({
      stage: 'best_signal',
      symbol,
      timeframe: bestSignal.timeframe || bestSignal.tf || null,
      mode: 'short',
      graderInput: null,
      signal: bestSignal,
      context: {
        category,
        mtfConfirmation,
        selectedFrom: tfSignals.map(s => ({
          timeframe: s.timeframe || s.tf || null,
          grade: s.grade || null,
          direction: s.direction || null,
          conviction: s.tally?.conviction ?? null,
        })),
      },
    }));
  } catch (e) {
    console.warn(`[DecisionSnapshot] ${symbol}/best yazilamadi: ${e.message}`);
    recordShadowDrop('snapshot', e?.message);
  }

  // Record signal for learning (only non-IPTAL best signal)
  let transitionDirective = null;
  if (bestSignal.grade && bestSignal.grade !== 'IPTAL' && bestSignal.grade !== 'HATA') {
    try {
      const recorded = recordSignal({ ...bestSignal, mode: 'short', mtfConfirmation });
      if (recorded?.transitionDirective) {
        transitionDirective = recorded.transitionDirective;
      }
    } catch (e) { recordShadowDrop('learning', e?.message); /* should not block scanning */ }
  }

  // Build the comprehensive result
  return {
    symbol,
    mode: 'short',
    category,
    // Best signal fields (for backward compatibility)
    ...bestSignal,
    // Multi-TF data
    multiTF: true,
    higherTFTrend,
    scannedTimeframes: tfsToScan.map(tfLabel),
    trendTimeframes: singleTF ? [] : assetTrendTFs.map(tfLabel),
    tfSignals: tfSignals.map(s => ({
      tf: s.tf,
      tfLabel: s.tfLabel || tfLabel(s.tf),
      grade: s.grade,
      direction: s.direction,
      khanSaabBias: s.khanSaabBias,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      tp3: s.tp3,
      rr: s.rr,
      slDistancePct: s.slDistancePct,
      error: s.error,
    })),
    mtfConfirmation,
    macroState,
    transitionDirective,
    indicatorWarnings: indicatorSetup?.warnings || [],
    timestamp: new Date().toISOString(),
  };
}

// Re-export for use in server API
export { getSignalHistory } from './learning/signal-tracker.js';

/**
 * Long-term MULTI-TIMEFRAME scan for a single symbol.
 * Scans 4H, 1D, 3D, 1W, 1M with Supertrend + IFCCI.
 */
export async function scanLongTerm(symbol, options = {}) {
  return withScanLifecycle(`long:${symbol}`, () => _scanLongTermInner(symbol, options));
}

async function _scanLongTermInner(symbol, options = {}) {
  const timeframes = options.timeframes || LONG_TERM_TFS;
  const singleTF = options.singleTF;

  const tfsToScan = singleTF ? [singleTF] : timeframes;
  const tfResults = {};
  const tfSignals = [];

  // Setup indicators (ensure Supertrend + IFCCI)
  let indicatorSetup;
  try {
    indicatorSetup = await bridge.setupIndicatorsForScan('long');
  } catch { indicatorSetup = { warnings: [] }; }

  for (const tf of tfsToScan) {
    try {
      const data = await collectLongTermData(symbol, tf);

      const signal = gradeLongTermSignal({
        studyValues: data.studyValues,
        ohlcv: data.ohlcv,
        formation: data.formation,
        symbol,
        timeframe: tf,
      });

      signal.tf = tf;
      signal.tfLabel = tfLabel(tf);
      tfResults[tf] = signal;
      tfSignals.push(signal);
    } catch (e) {
      const errSignal = { tf, tfLabel: tfLabel(tf), error: e.message, grade: 'HATA' };
      tfResults[tf] = errSignal;
      tfSignals.push(errSignal);
    }
  }

  // Multi-TF trend agreement
  const validSignals = tfSignals.filter(s => s.action && s.action !== 'BEKLE' && !s.error);
  let trendAgreement = null;

  if (validSignals.length > 1) {
    const longCount = validSignals.filter(s => s.action?.includes('LONG')).length;
    const shortCount = validSignals.filter(s => s.action?.includes('SHORT')).length;
    const total = validSignals.length;

    if (longCount > shortCount) {
      trendAgreement = { direction: 'LONG', agreement: Math.round(longCount / total * 100), count: longCount, total };
    } else if (shortCount > longCount) {
      trendAgreement = { direction: 'SHORT', agreement: Math.round(shortCount / total * 100), count: shortCount, total };
    } else {
      trendAgreement = { direction: 'KARISIK', agreement: 0, count: 0, total };
    }
  }

  // Trend yonu disinda trade onerilmez (uzun vade kural).
  // Entry TF (1D) sinyali, ust TF'lerin (3D/1W/1M) coklu trend yonuyle uyumsuzsa IPTAL edilir.
  if (trendAgreement && trendAgreement.direction !== 'KARISIK') {
    const entryTfResult = tfResults[LONG_ENTRY_TF];
    if (entryTfResult && entryTfResult.action && entryTfResult.action !== 'BEKLE') {
      const entryIsLong = entryTfResult.action.includes('LONG');
      const trendIsLong = trendAgreement.direction === 'LONG';
      if (entryIsLong !== trendIsLong) {
        entryTfResult.action = 'BEKLE';
        entryTfResult.combination = 'TREND UYUMSUZ';
        entryTfResult.reasoning = entryTfResult.reasoning || [];
        entryTfResult.reasoning.push(
          `IPTAL: Giris yonu (${entryIsLong ? 'LONG' : 'SHORT'}) trend yonuyle (${trendAgreement.direction}) uyumsuz — uzun vadede trend disinda trade onerilmez`
        );
      }
    }
  }

  return {
    symbol,
    mode: 'long',
    multiTF: true,
    scannedTimeframes: tfsToScan.map(tfLabel),
    timeframes: tfResults,
    tfSignals: tfSignals.map(s => ({
      tf: s.tf,
      tfLabel: s.tfLabel,
      supertrend: s.supertrend,
      ifcci: s.ifcci,
      action: s.action,
      formation: s.formation,
      error: s.error,
    })),
    trendAgreement,
    indicatorWarnings: indicatorSetup?.warnings || [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Full batch scan — iterates all symbols in a watchlist category.
 */
// Per-symbol scheduler cooldown: prevents scheduler from re-scanning the same
// symbol within SYMBOL_COOLDOWN_MS. Manual /api/scan/batch calls bypass this.
const _lastScheduledScanAt = new Map(); // symbol -> timestamp ms
const SYMBOL_COOLDOWN_MS = 15 * 60 * 1000;

export function canScheduleSymbol(symbol) {
  const last = _lastScheduledScanAt.get(symbol);
  if (!last) return true;
  return (Date.now() - last) >= SYMBOL_COOLDOWN_MS;
}
export function markSymbolScheduled(symbol) {
  _lastScheduledScanAt.set(symbol, Date.now());
}

export async function batchScan(category, mode = 'short', options = {}) {
  return withScanLifecycle(`batch:${category}:${mode}`, () => _batchScanInner(category, mode, options));
}

async function _batchScanInner(category, mode = 'short', options = {}) {
  const rules = loadRules();
  const watchlist = rules.watchlist[category];
  const abortCheck = options.abortCheck || (() => false);

  if (!watchlist) {
    return { error: `Watchlist bulunamadi: ${category}` };
  }

  const skipSymbols = ['USDT.D', 'BTC.D', 'DXY', 'VIX', 'US10Y'];
  let symbols = watchlist.filter(s => !skipSymbols.includes(s));

  // Per-symbol cooldown: if scheduler is calling (respectCooldown=true),
  // skip symbols scanned within the last 15 minutes. Manual batch calls bypass.
  if (options.respectCooldown) {
    const before = symbols.length;
    symbols = symbols.filter(s => {
      if (canScheduleSymbol(s)) return true;
      console.log(`[Scheduler] ${s} — 15dk cooldown, atlaniyor`);
      return false;
    });
    if (before !== symbols.length) {
      console.log(`[Scheduler] ${category}: ${before - symbols.length}/${before} sembol cooldown ile atlanti`);
    }
  }

  const results = [];
  const scanFn = mode === 'short' ? _scanShortTermInner : _scanLongTermInner;

  let macroState;
  try { macroState = await getMacroState(true, true); } catch { macroState = null; } // alreadyLocked=true: batchScan holds the lock

  const scanStartTime = Date.now();
  let aborted = false;

  for (const symbol of symbols) {
    // Check abort between each symbol
    if (abortCheck()) {
      aborted = true;
      console.log(`[Scanner] ${category} taramasi iptal edildi (${results.length}/${symbols.length} sembol tarandi)`);
      break;
    }

    try {
      const result = await scanFn(symbol, options);
      result.timestamp = new Date().toISOString();
      results.push(result);
      if (options.respectCooldown) markSymbolScheduled(symbol);
    } catch (e) {
      results.push({
        symbol,
        error: e.message,
        grade: 'HATA',
        timestamp: new Date().toISOString(),
      });
    }
  }

  const scanDuration = Math.round((Date.now() - scanStartTime) / 1000);

  return {
    category,
    mode,
    symbolCount: symbols.length,
    scannedCount: results.length,
    scanDuration: `${scanDuration}s`,
    aborted,
    macroState,
    macroSummary: formatMacroSummary(macroState),
    results,
    signals: results.filter(r => r.grade && r.grade !== 'HATA'),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Custom single symbol analysis.
 * - With singleTF: scans only that timeframe
 * - Without singleTF: runs full multi-TF scan for the mode
 */
export async function customScan(symbol, options = {}) {
  const { mode = 'short', singleTF } = options;

  if (mode === 'short') {
    return scanShortTerm(symbol, { singleTF });
  } else {
    return scanLongTerm(symbol, { singleTF });
  }
}

// --- Helper extractors ---

function extractRSIFromStudy(studyValues) {
  if (!studyValues || !Array.isArray(studyValues)) return null;
  for (const study of studyValues) {
    if (!study.values) continue;
    for (const [key, val] of Object.entries(study.values)) {
      if (key.toLowerCase().includes('rsi') && typeof val === 'number') {
        return val;
      }
    }
  }
  return null;
}

function extractATRFromStudy(studyValues) {
  if (!studyValues || !Array.isArray(studyValues)) return null;
  for (const study of studyValues) {
    if (!study.values) continue;
    for (const [key, val] of Object.entries(study.values)) {
      if (key.toLowerCase().includes('atr') && typeof val === 'number') {
        return val;
      }
    }
  }
  return null;
}

function extractEMAFromStudy(studyValues) {
  if (!studyValues || !Array.isArray(studyValues)) return null;
  for (const study of studyValues) {
    const name = (study.name || '').toLowerCase();
    if (!name.includes('ema') && !name.includes('moving average exp')) continue;
    if (study.values) {
      const val = Object.values(study.values).find(v => typeof v === 'number');
      if (val) return val;
    }
  }
  return null;
}

/**
 * 2026-05-02 — regime classifier ema20'yi okurken bos kalmasin diye.
 * EMA-tipi study'leri tarayip period == 20 olani veya en kucuk EMA degerini doner.
 * tv-bridge `ema21` istiyor ama charta `ema20` da eklenebiliyor; isim/kanal
 * kombinasyonlarinin hepsini dener: keys'te "ema20", "ema 20", "ma20", "20" geciyorsa
 * o kanali tercih eder; yoksa ilk numerical EMA degerini geri doner.
 */
function extractEMA20FromStudy(studyValues) {
  if (!Array.isArray(studyValues)) return null;
  // 1. Once isim/period eslesmesi
  for (const study of studyValues) {
    const name = (study.name || '').toLowerCase();
    if (!name.includes('ema') && !name.includes('moving average exp')) continue;
    if (!study.values) continue;
    // a) study.inputs varsa period === 20 mi?
    if (Array.isArray(study.inputs) && study.inputs.includes(20)) {
      const val = Object.values(study.values).find(v => typeof v === 'number');
      if (Number.isFinite(val)) return val;
    }
    // b) values key'lerinde "20" geciyorsa
    for (const [key, val] of Object.entries(study.values)) {
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      const k = key.toLowerCase();
      if (/(^|[^0-9])20([^0-9]|$)/.test(k) && (k.includes('ema') || k.includes('ma'))) return val;
    }
  }
  // 2. Fallback: ema21'i kullan (yakın approximation; null kalmaktan iyidir)
  return extractEMAFromStudy(studyValues);
}

/**
 * 2026-05-02 — Bollinger Bands kanallari (Upper, Lower, Basis/Middle).
 * tv-bridge `bb: { fullName: 'Bollinger Bands', inputs: [20, 2] }` ile ekliyor.
 * Pine `plot` kanal isimleri: "Upper", "Lower", "Basis" (bazi varyantlar "Middle").
 */
/**
 * 2026-05-02 — OHLCV bar'larindan yerel EMA(20) hesaplayicisi.
 * Chart'ta EMA20 study'si olmasa bile rejim klasifiye edicisinin priceAboveEma20
 * sinyalini bos birakmamak icin. K = 2/(N+1).
 */
function computeEMA20FromBars(bars, period = 20) {
  if (!Array.isArray(bars) || bars.length < period) return null;
  const closes = bars.map(b => Number(b.close)).filter(Number.isFinite);
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // SMA seed
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return Number.isFinite(ema) ? ema : null;
}

/**
 * 2026-05-02 — OHLCV bar'larindan yerel Bollinger Bands(20, 2σ) hesaplayicisi.
 * basis = 20-bar SMA, upper/lower = basis ± 2 × stdev. Chart-bagimsiz.
 */
function computeBBFromBars(bars, period = 20, mult = 2) {
  const empty = { upper: null, lower: null, basis: null };
  if (!Array.isArray(bars) || bars.length < period) return empty;
  const closes = bars.slice(-period).map(b => Number(b.close)).filter(Number.isFinite);
  if (closes.length < period) return empty;
  const mean = closes.reduce((s, x) => s + x, 0) / closes.length;
  const variance = closes.reduce((s, x) => s + (x - mean) ** 2, 0) / closes.length;
  const sd = Math.sqrt(variance);
  if (!Number.isFinite(sd) || sd <= 0) return { upper: mean, lower: mean, basis: mean };
  return { upper: mean + mult * sd, lower: mean - mult * sd, basis: mean };
}

function extractBBFromStudy(studyValues) {
  if (!Array.isArray(studyValues)) return { upper: null, lower: null, basis: null };
  for (const study of studyValues) {
    const name = (study.name || '').toLowerCase();
    if (!name.includes('bollinger')) continue;
    if (!study.values) continue;
    let upper = null, lower = null, basis = null;
    for (const [key, val] of Object.entries(study.values)) {
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      const k = key.toLowerCase();
      if (k.includes('upper') || k === 'ub' || k.includes('top'))  upper = val;
      else if (k.includes('lower') || k === 'lb' || k.includes('bottom')) lower = val;
      else if (k.includes('basis') || k.includes('middle') || k.includes('median') || k === 'mb' || k === 'ma') basis = val;
    }
    // Bazı export'lar isimsiz kanal döndürüyor; en yüksek/en düşük/orta varsayımı ile fallback
    if (upper == null || lower == null || basis == null) {
      const nums = Object.values(study.values).filter(v => typeof v === 'number' && Number.isFinite(v));
      if (nums.length >= 3) {
        const sorted = [...nums].sort((a, b) => a - b);
        if (lower == null) lower = sorted[0];
        if (upper == null) upper = sorted[sorted.length - 1];
        if (basis == null) basis = sorted[Math.floor(sorted.length / 2)];
      }
    }
    if (upper != null && lower != null && basis != null) return { upper, lower, basis };
  }
  return { upper: null, lower: null, basis: null };
}
