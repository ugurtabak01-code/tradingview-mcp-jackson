/**
 * signal-loader — analiz script'leri icin ortak sinyal yukleme + resolved
 * (cozulmus) tespiti. Daha once analyze-shadow-indicators / analyze-crypto-
 * indicator-efficiency / analyze-advisory-correlation / analyze-bad-signal-
 * indicators dosyalarinda birebir kopyalanmisti; yeni bir status eklendiginde
 * 4 yerde guncelleme gerekiyordu. Tek kaynak burasi.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNALS_DIR = path.resolve(__dirname, '..', '..', 'data', 'signals');

// Hala aktif (henuz cozulmemis) pozisyonlar.
const ACTIVE_STATUSES = new Set(['open', 'tp1_hit', 'tp2_hit']);

// Notr statusler — win/loss anlami tasimaz (iptal/sure dolmasi/gecersiz veri).
// Learning ve outcome-korelasyon analizlerinde sayilmamalidir.
export const NEUTRAL_STATUSES = new Set([
  'entry_expired', 'entry_missed_tp', 'invalid_data',
  'superseded', 'superseded_by_tf', 'superseded_by_cap',
  'superseded_by_reverse', 'superseded_by_cleanup', 'manual_close',
]);

/** Sinyalin notr (iptal/gecersiz) bir status'u var mi? */
export function isNeutralStatus(s) {
  return !!s && NEUTRAL_STATUSES.has(s.status);
}

/** Kesin win/loss outcome'u var mi? (aktif veya notr olanlar haric) */
export function isResolved(s) {
  if (!s || !s.status) return false;
  if (ACTIVE_STATUSES.has(s.status)) return false;
  if (NEUTRAL_STATUSES.has(s.status)) return false;
  return s.win === true || s.win === false;
}

/**
 * open.json + archive/*.json icindeki tum sinyalleri yukler.
 * legacy / broken / backup iceren dosyalar atlanir.
 * @param {{ dedupe?: boolean }} opts dedupe=true ise id bazli tekillestirme yapar.
 */
export function loadAllSignals({ dedupe = false } = {}) {
  const all = [];

  const openPath = path.join(SIGNALS_DIR, 'open.json');
  if (fs.existsSync(openPath)) {
    const j = JSON.parse(fs.readFileSync(openPath, 'utf8'));
    all.push(...(Array.isArray(j) ? j : (j.signals || [])));
  }

  const archDir = path.join(SIGNALS_DIR, 'archive');
  if (fs.existsSync(archDir)) {
    for (const f of fs.readdirSync(archDir)) {
      if (!f.endsWith('.json')) continue;
      if (f.includes('legacy') || f.includes('broken') || f.includes('backup')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(archDir, f), 'utf8'));
      all.push(...(Array.isArray(j) ? j : (j.signals || [])));
    }
  }

  if (!dedupe) return all;
  const seen = new Set();
  return all.filter(s => {
    if (!s || s.id == null) return true;
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}
