#!/usr/bin/env node
/**
 * Shadow Feature Report (v1)
 *
 * Reads the latest shadow-features-backfill-*.json sidecar and reports, per
 * feature, how the risk flag separates losing vs winning trades. READ-ONLY:
 * touches no archive, no live decision path.
 *
 * For each backfillable feature:
 *   - loss/win split of riskFlag fire rate
 *   - $10+ loss capture (riskFlag true among pnl <= -$10)
 *   - winner-elimination risk (riskFlag true rate among winners)
 *   - category & regime breakdown
 * Missing data is NOT counted as "no risk" — it is tallied separately.
 * Forward-mode features are listed with their missingReason only.
 *
 * Usage: node scanner/scripts/shadow-feature-report.mjs [sidecarPath]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_DIR = path.join(__dirname, '..', 'data', 'learning');

function latestSidecar() {
  const files = fs.readdirSync(LEARNING_DIR)
    .filter(f => f.startsWith('shadow-features-backfill-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  return path.join(LEARNING_DIR, files[files.length - 1]);
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(0) + '%' : '-'; }

function main() {
  const sidecarPath = process.argv[2] || latestSidecar();
  if (!sidecarPath || !fs.existsSync(sidecarPath)) {
    console.error('Sidecar bulunamadı. Önce backfill-shadow-features.mjs çalıştırın.');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  const all = payload.records || [];
  const resolved = all.filter(r => r.outcomeKnown);
  const losers = resolved.filter(r => r.pnlPct < 0);
  const winners = resolved.filter(r => r.pnlPct > 0);
  const big = resolved.filter(r => r.pnlPct <= -10);

  console.log(`Shadow Feature Raporu — ${path.basename(sidecarPath)}`);
  console.log(`schema v${payload.shadowFeaturesVersion} | kayıt ${all.length} | outcome bilinen ${resolved.length}`);
  console.log(`  zararlı ${losers.length} | kazanan ${winners.length} | $10+ zarar ${big.length}\n`);

  // collect feature keys
  const keys = new Map(); // key -> { family, mode }
  for (const r of resolved) {
    for (const f of r.shadowFeatures?.features || []) {
      if (!keys.has(f.key)) keys.set(f.key, { family: f.family, mode: f.mode });
    }
  }

  const getF = (r, key) => (r.shadowFeatures?.features || []).find(f => f.key === key);

  // helper: riskFlag fire / missing counts within a group
  function tally(group, key) {
    let fired = 0, notFired = 0, missing = 0;
    for (const r of group) {
      const f = getF(r, key);
      if (!f || f.riskFlag == null) missing++;
      else if (f.riskFlag === true) fired++;
      else notFired++;
    }
    return { fired, notFired, missing, evaluable: fired + notFired };
  }

  const backfillKeys = [...keys.entries()].filter(([, v]) => v.mode === 'backfill');
  const forwardKeys = [...keys.entries()].filter(([, v]) => v.mode === 'forward');

  console.log('=== BACKFILL FEATURE\'LARI (riskFlag loss/win ayrımı) ===\n');
  for (const [key, meta] of backfillKeys) {
    const L = tally(losers, key), W = tally(winners, key), B = tally(big, key);
    console.log(`[${meta.family}] ${key}`);
    console.log(`  zararlıda riskFlag: ${L.fired}/${L.evaluable} (${pct(L.fired, L.evaluable)})  | eksik veri: ${L.missing}`);
    console.log(`  kazananda riskFlag: ${W.fired}/${W.evaluable} (${pct(W.fired, W.evaluable)})  | eksik veri: ${W.missing}  ← kazanan eleme riski`);
    console.log(`  $10+ zarar yakalama: ${B.fired}/${B.evaluable} (${pct(B.fired, B.evaluable)})  | eksik veri: ${B.missing}`);
    const lift = (L.evaluable && W.evaluable)
      ? (L.fired / L.evaluable - W.fired / W.evaluable) * 100 : null;
    console.log(`  ayrışma (zararlı% − kazanan%): ${lift != null ? (lift > 0 ? '+' : '') + lift.toFixed(0) + 'pp' : '-'}`);

    // category breakdown
    const cats = [...new Set(resolved.map(r => r.category).filter(Boolean))];
    const catRows = [];
    for (const c of cats) {
      const cl = tally(losers.filter(r => r.category === c), key);
      const cw = tally(winners.filter(r => r.category === c), key);
      catRows.push(`${c}: zar ${cl.fired}/${cl.evaluable} kaz ${cw.fired}/${cw.evaluable}`);
    }
    console.log(`  kategori: ${catRows.join('  |  ')}`);

    // regime breakdown
    const regs = [...new Set(resolved.map(r => r.regime).filter(Boolean))];
    const regRows = [];
    for (const rg of regs) {
      const rl = tally(losers.filter(r => r.regime === rg), key);
      const rw = tally(winners.filter(r => r.regime === rg), key);
      if (rl.evaluable + rw.evaluable === 0) continue;
      regRows.push(`${rg}: zar ${rl.fired}/${rl.evaluable} kaz ${rw.fired}/${rw.evaluable}`);
    }
    console.log(`  rejim: ${regRows.join('  |  ')}\n`);
  }

  console.log('=== FORWARD-ONLY FEATURE\'LAR (v1 backfill yok) ===');
  for (const [key, meta] of forwardKeys) {
    const sample = resolved.map(r => getF(r, key)).find(Boolean);
    console.log(`  [${meta.family}] ${key} — missingReason: ${sample?.missingReason ?? 'n/a'}`);
  }
}

main();
