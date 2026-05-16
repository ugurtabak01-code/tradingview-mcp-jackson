#!/usr/bin/env node
/**
 * Backfill Shadow Features (v1 — DRY-RUN / SIDECAR ONLY)
 *
 * Computes shadowFeatures for archived signals using computeShadowFeatures()
 * and writes them to a SIDECAR file. It NEVER mutates the archive in place.
 *
 *   output: scanner/data/learning/shadow-features-backfill-<ts>.json
 *
 * Only fields already stored on each archive record are used — no OHLCV
 * refetch, no external API. Features that need a series / external data come
 * back as forward-mode placeholders with a missingReason (no fake history).
 *
 * Usage: node scanner/scripts/backfill-shadow-features.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeShadowFeatures, SHADOW_FEATURES_VERSION } from '../lib/learning/shadow-features.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNALS_DIR = path.join(__dirname, '..', 'data', 'signals');
const OUT_DIR = path.join(__dirname, '..', 'data', 'learning');
const ARCHIVE_FILES = ['archive/2026-04.json', 'archive/2026-05.json'];

function loadArchive(rel) {
  const fp = path.join(SIGNALS_DIR, rel);
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return (d.signals || []).filter(Boolean);
  } catch {
    return [];
  }
}

/** Realized P&L % on a $100 base — mirrors server.js computeRealizedPnlPct. */
function realizedPnlPct(s) {
  if (!s.entry || !Number.isFinite(s.entry) || s.entryHit === false) return null;
  let ex = null;
  if (s.status === 'trailing_stop_exit' && s.slHitPrice != null) ex = s.slHitPrice;
  else if (s.tp3Hit && s.tp3 != null) ex = s.tp3;
  else if (s.tp2Hit && s.tp2 != null) ex = s.tp2;
  else if (s.tp1Hit && s.tp1 != null) ex = s.tp1;
  else if (s.slHit && (s.slHitPrice != null || s.sl != null)) ex = s.slHitPrice != null ? s.slHitPrice : s.sl;
  else if (s.lastCheckedPrice != null) ex = s.lastCheckedPrice;
  if (ex == null || !Number.isFinite(ex)) return null;
  const reward = s.direction === 'long' ? ex - s.entry : s.entry - ex;
  return Math.round((reward / s.entry) * 10000) / 100;
}

function main() {
  const records = [];
  for (const rel of ARCHIVE_FILES) {
    for (const s of loadArchive(rel)) {
      const sf = computeShadowFeatures(s);
      const pnlPct = realizedPnlPct(s);
      records.push({
        id: s.id ?? null,
        symbol: s.symbol ?? null,
        category: s.category ?? null,
        regime: s.regime ?? null,
        timeframe: s.timeframe ?? s.tf ?? null,
        direction: s.direction ?? null,
        grade: s.grade ?? null,
        archiveFile: rel,
        resolvedAt: s.resolvedAt ?? null,
        pnlPct,
        outcomeKnown: pnlPct != null,
        shadowFeatures: sf,
      });
    }
  }

  const withPnl = records.filter(r => r.outcomeKnown).length;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `shadow-features-backfill-${ts}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const payload = {
    schema: 'shadow_features_backfill',
    shadowFeaturesVersion: SHADOW_FEATURES_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'dry-run-sidecar',
    note: 'Archive NOT mutated. Sidecar output only.',
    archiveFiles: ARCHIVE_FILES,
    totalRecords: records.length,
    recordsWithOutcome: withPnl,
    records,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 1), 'utf8');

  console.log(`[backfill-shadow-features] dry-run — arşiv değiştirilmedi.`);
  console.log(`  toplam kayıt: ${records.length} | outcome bilinen: ${withPnl}`);
  console.log(`  sidecar: ${outPath}`);
}

main();
