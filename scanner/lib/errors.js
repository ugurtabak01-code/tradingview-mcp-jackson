/**
 * scanner-engine error taksonomisi — Patch 5 / D14.
 *
 * Tum scan throw'lari machine-readable `error.code` ile etiketlenir.
 * Mesaj formati KORUNUR (backward compat); yalniz code/context alanlari
 * eklenir. Scheduler ve dashboard error.code uzerinden kategorize alarm
 * ve cooldown stratejisi kurabilir.
 *
 * NOT: bridge-timeout.js'in CdpTimeoutError sinifi (code='CDP_TIMEOUT')
 * bu modulden ONCE eklendi; uyumlu — `isScanError` ikisini de yakalar.
 */

/**
 * Bilinen kod taksonomisi. String literal yerine bu enum kullanin:
 *   throw new ScanError('CHART_SYMBOL_MISMATCH', '...', { symbol, tf });
 */
export const ScanErrorCode = Object.freeze({
  SYMBOL_SWITCH_FAILED:    'SYMBOL_SWITCH_FAILED',
  BAR_DATA_TIMEOUT:        'BAR_DATA_TIMEOUT',
  CHART_SYMBOL_MISMATCH:   'CHART_SYMBOL_MISMATCH',
  OHLCV_CONTAMINATED:      'OHLCV_CONTAMINATED',
  OHLCV_STALE:             'OHLCV_STALE',
  OHLCV_DEVIATION:         'OHLCV_DEVIATION',
  CDP_TIMEOUT:             'CDP_TIMEOUT', // bridge-timeout ile uyumlu
});

/**
 * Scan-spesifik hata. `message` mevcut Turkce aciklayici string'i korur
 * (caller'lar `.includes('CONTAMINATED')` gibi match yapiyor olabilir);
 * machine-okuma icin `code` ve `context` alanlari eklenir.
 */
export class ScanError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
    this.symbol = context.symbol ?? null;
    this.timeframe = context.timeframe ?? null;
    Object.assign(this, context);
  }
}

/**
 * isScanError — guard. CdpTimeoutError de code field'ina sahip oldugu icin
 * uniform katergorize edilir.
 */
export function isScanError(err) {
  return Boolean(err && typeof err.code === 'string');
}

// ---------------------------------------------------------------------------
// Factory'ler — yaygin throw senaryolarini sade tek-satira indirir
// ---------------------------------------------------------------------------

export function symbolSwitchFailed(symbol, chartSymbol, warning) {
  const msg = warning
    ? `Sembol degistirilemedi: ${chartSymbol} — ${warning}`
    : `Sembol degistirilemedi: ${chartSymbol}`;
  return new ScanError(ScanErrorCode.SYMBOL_SWITCH_FAILED, msg, { symbol, chartSymbol });
}

export function barDataTimeout(symbol, tf, ltf = false) {
  const tag = ltf ? ' (LTF)' : '';
  const ctx = ltf ? ', veri kirletme riski → ABORT' : ', onceki sembolun barlari kirletme riski → ABORT';
  const msg = `${symbol} TF${tf}${tag}: Bar verisi 20s icinde degismedi — chart sembolu yuklemiyor${ctx}`;
  return new ScanError(ScanErrorCode.BAR_DATA_TIMEOUT, msg, { symbol, timeframe: tf });
}

export function chartSymbolMismatch(symbol, tf, reason, opts = {}) {
  const stage = opts.ltf ? ' (LTF)' : '';
  const phase = opts.postRead ? 'Veri okuma sirasinda sembol dogrulanamadi' : 'Sembol dogrulanamadi';
  const suffix = opts.postRead ? ' — veri CONTAMINATED' : (opts.ltf ? '' : ' — veri GUVENILMEZ, atlaniyor');
  const msg = `${phase}${stage}: ${reason}${suffix}`;
  return new ScanError(ScanErrorCode.CHART_SYMBOL_MISMATCH, msg, { symbol, timeframe: tf });
}

export function ohlcvContaminated(symbol, tf, expected, got, opts = {}) {
  const stage = opts.ltf ? ' (LTF)' : '';
  const retry = opts.retry ? ' retry' : '';
  const intro = opts.retry
    ? `OHLCV${retry} symbol mismatch`
    : `OHLCV okuma aninda chart sembolu ${got}, beklenen ${expected}`;
  const detail = opts.retry ? ` (beklenen ${expected}, alinan ${got})` : '';
  const msg = `${symbol} TF${tf}${stage}: ${intro}${detail} — veri CONTAMINATED`;
  return new ScanError(ScanErrorCode.OHLCV_CONTAMINATED, msg, {
    symbol, timeframe: tf, expected, got,
  });
}

export function ohlcvStale(symbol, tf, lastBarAge, opts = {}) {
  const stage = opts.ltf ? ' (LTF)' : '';
  const retryTag = opts.retry ? ' hala' : '';
  const reason = opts.withDeviation
    ? ` ve sapma %${opts.deviationPct.toFixed(1)}`
    : ' — chart donmus';
  const msg = `${symbol} TF${tf}${stage}: Bar verisi${retryTag} stale (yas: ${lastBarAge}s)${reason} — veri GUVENILMEZ`;
  return new ScanError(ScanErrorCode.OHLCV_STALE, msg, {
    symbol, timeframe: tf, lastBarAge,
  });
}

export function ohlcvDeviation(symbol, tf, barClose, quotePrice, deviationPct) {
  const msg = `${symbol} TF${tf}: Fiyat dogrulanamadi (bar=${barClose}, quote=${quotePrice}, sapma=%${deviationPct.toFixed(1)}) — veri GUVENILMEZ`;
  return new ScanError(ScanErrorCode.OHLCV_DEVIATION, msg, {
    symbol, timeframe: tf, barClose, quotePrice, deviationPct,
  });
}
