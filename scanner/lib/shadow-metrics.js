/**
 * scanner-engine shadow path drop counter — Patch 5 / D15.
 *
 * Shadow path'lerde silent catch'ler yaygin (computeShadowFeatures, regime
 * shadow logger, fib cache, fundamentals snapshot, learning recordSignal).
 * Hatalari yutmak canli karari koruyor ama "sessiz veri kaybi" gozukmuyor.
 * Bu modul her kategori icin in-memory counter + getter saglar; /api/health
 * uzerinden expose edilebilir.
 *
 * Hicbir counter scan kararini etkilemez — pure observability.
 */

const _counters = {
  regime:         0,
  snapshot:       0,
  fib:            0,
  fundamentals:   0,
  shadow_mtf:     0,
  shadow_features: 0,
  learning:       0,
};

const _firstSeen = {};
const _lastSeen = {};

/**
 * Counter'i bir artir + first/last timestamp guncelle.
 * Kategori bilinmeyense sessizce ignore (typo guard yok — ekleme zamani
 * bilincli yapilsin diye).
 */
export function recordShadowDrop(category, errorMessage = null) {
  if (!(category in _counters)) return;
  _counters[category] += 1;
  const now = Date.now();
  if (!_firstSeen[category]) _firstSeen[category] = now;
  _lastSeen[category] = now;
  // Console'a duşur ki canli izleme yapan kullanici sessizce kaybetmesin.
  // Log spam'i onlemek icin yalniz ilk 5 ve sonra her 50'de bir.
  const n = _counters[category];
  if (n <= 5 || n % 50 === 0) {
    const tail = errorMessage ? ` — ${errorMessage}` : '';
    console.warn(`[shadow-drop] ${category} #${n}${tail}`);
  }
}

/**
 * Tum counter snapshot'i — /api/health endpoint'i icin.
 */
export function getShadowMetrics() {
  return {
    counters: { ..._counters },
    firstSeen: { ..._firstSeen },
    lastSeen: { ..._lastSeen },
    totalDrops: Object.values(_counters).reduce((s, v) => s + v, 0),
  };
}

/**
 * Test izolasyonu icin reset.
 */
export function _resetShadowMetrics() {
  for (const k of Object.keys(_counters)) _counters[k] = 0;
  for (const k of Object.keys(_firstSeen)) delete _firstSeen[k];
  for (const k of Object.keys(_lastSeen)) delete _lastSeen[k];
}
