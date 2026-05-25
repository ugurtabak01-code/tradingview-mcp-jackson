#!/usr/bin/env node
/**
 * Shadow Indicator Başarı Analizi
 *
 * Tüm resolved sinyallerde shadowVotes geçmişini tarar, her shadow indikatoru
 * için:
 *   - aligned (yön sinyal yönü ile aynı): kaç kez ve kaç kazandı
 *   - opposed (yön sinyal yönü ile zıt): kaç kez ve kaç kazandı
 *   - lift = aligned_winrate - baseline_winrate
 *   - z-score (istatistiksel anlamlılık)
 *   - classification (load_bearing / useful / decorative / counterproductive)
 *
 * Live indicator-scorer.js ile birebir methodology — adil karşılaştırma sağlar.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAllSignals, isResolved } from '../lib/learning/signal-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function computeZScore(p1, p0, n) {
  if (!Number.isFinite(p1) || !Number.isFinite(p0) || !n) return 0;
  const se = Math.sqrt(p0 * (1 - p0) / n);
  if (se === 0) return 0;
  return (p1 - p0) / se;
}

function scoreShadowIndicator(key, signals) {
  let aligned = 0, alignedWin = 0;
  let opposed = 0, opposedWin = 0;
  let absent = 0;
  for (const s of signals) {
    const votes = Array.isArray(s.shadowVotes) ? s.shadowVotes : [];
    const match = votes.find(v => v.source === key && !v.kind); // directional, not multiplier
    if (!match) { absent++; continue; }
    if (!match.direction) { absent++; continue; }
    if (match.direction === s.direction) {
      aligned++; if (s.win) alignedWin++;
    } else {
      opposed++; if (s.win) opposedWin++;
    }
  }
  const alignedWR = aligned ? alignedWin / aligned : null;
  const opposedWR = opposed ? opposedWin / opposed : null;
  const baselineWR = signals.length ? signals.filter(s => s.win).length / signals.length : 0;
  const lift = alignedWR != null ? (alignedWR - baselineWR) * 100 : null;
  const contrarianLift = opposedWR != null ? (opposedWR - baselineWR) * 100 : null;
  const z = aligned >= 5 ? computeZScore(alignedWR, baselineWR, aligned) : 0;
  // Bonferroni: ~12-15 indicator → α=0.05/15 → |z|>2.71 sağlam
  const significant = aligned >= 20 && Math.abs(z) > 2.0;

  let classification = 'insufficient_data';
  if (aligned >= 20) {
    if (lift > 15 && significant) classification = 'load_bearing';
    else if (lift > 5) classification = 'useful';
    else if (lift > -5) classification = 'decorative';
    else classification = 'counterproductive';
  } else if (aligned >= 10) {
    classification = 'preliminary';
  }

  return {
    key,
    n_total: signals.length,
    n_aligned: aligned,
    n_opposed: opposed,
    n_absent: absent,
    aligned_wr_pct: alignedWR != null ? Math.round(alignedWR * 1000) / 10 : null,
    opposed_wr_pct: opposedWR != null ? Math.round(opposedWR * 1000) / 10 : null,
    baseline_wr_pct: Math.round(baselineWR * 1000) / 10,
    lift_pct: lift != null ? Math.round(lift * 10) / 10 : null,
    contrarian_lift_pct: contrarianLift != null ? Math.round(contrarianLift * 10) / 10 : null,
    z_score: Math.round(z * 100) / 100,
    significant,
    classification,
  };
}

function main() {
  const all = loadAllSignals();
  const resolved = all.filter(isResolved);
  const shadowEnabled = resolved.filter(s => Array.isArray(s.shadowVotes) && s.shadowVotes.length > 0);

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('   SHADOW INDIKATOR BAŞARI ANALİZİ');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Toplam sinyal              : ${all.length}`);
  console.log(`Resolved (win/loss var)    : ${resolved.length}`);
  console.log(`Shadow vote'lu resolved    : ${shadowEnabled.length}`);
  const realResolved = shadowEnabled.filter(s => ['A','B','C'].includes(s.grade));
  const virtualResolved = shadowEnabled.filter(s => s.grade === 'BEKLE');
  console.log(`  • Gerçek (A/B/C)         : ${realResolved.length}  (genel WR: ${realResolved.filter(s=>s.win).length}/${realResolved.length} = %${Math.round(realResolved.filter(s=>s.win).length/(realResolved.length||1)*1000)/10})`);
  console.log(`  • Sanal (BEKLE)          : ${virtualResolved.length}  (genel WR: ${virtualResolved.filter(s=>s.win).length}/${virtualResolved.length} = %${Math.round(virtualResolved.filter(s=>s.win).length/(virtualResolved.length||1)*1000)/10})`);
  console.log('');

  // Tüm shadow source key'lerini topla
  const shadowKeys = new Set();
  for (const s of shadowEnabled) {
    for (const v of s.shadowVotes) {
      if (v.source && !v.kind) shadowKeys.add(v.source);
    }
  }

  function analyze(pool, label) {
    console.log('───────────────────────────────────────────────────────────────────');
    console.log(`  ${label}  (n=${pool.length})`);
    console.log('───────────────────────────────────────────────────────────────────');
    if (pool.length === 0) { console.log('  veri yok\n'); return []; }
    const scores = Array.from(shadowKeys).map(k => scoreShadowIndicator(k, pool));
    scores.sort((a, b) => (b.lift_pct ?? -999) - (a.lift_pct ?? -999));
    console.log('  KEY                        N_ALN  ALN_WR  OPP_WR  BASE  LIFT    Z     CLASS');
    for (const s of scores) {
      const k = s.key.padEnd(26);
      const n = String(s.n_aligned).padStart(5);
      const a = (s.aligned_wr_pct != null ? '%'+s.aligned_wr_pct : '  -  ').toString().padStart(7);
      const o = (s.opposed_wr_pct != null ? '%'+s.opposed_wr_pct : '  -  ').toString().padStart(7);
      const b = ('%'+s.baseline_wr_pct).padStart(6);
      const l = (s.lift_pct != null ? (s.lift_pct>=0?'+':'')+s.lift_pct : '  -  ').toString().padStart(7);
      const z = String(s.z_score).padStart(6);
      const c = s.classification + (s.significant ? ' *' : '');
      console.log(`  ${k} ${n} ${a} ${o} ${b} ${l} ${z}  ${c}`);
    }
    console.log('');
    return scores;
  }

  const realScores = analyze(realResolved, 'GERÇEK LIGA (A/B/C — live indikator havuzu icin)');
  const virtScores = analyze(virtualResolved, 'SANAL LIGA (BEKLE — gozlem amacli)');
  const allScores = analyze(shadowEnabled, 'TUM HAVUZ (real + virtual birlestik)');

  // TOP PERFORMERS
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('   TOP PERFORMER — LIVE\'A PROMOTE EDILEBILIR ADAYLAR');
  console.log('═══════════════════════════════════════════════════════════════════');
  const tops = allScores
    .filter(s => s.n_aligned >= 20 && s.lift_pct >= 5)
    .sort((a, b) => b.lift_pct - a.lift_pct);
  if (tops.length === 0) {
    console.log('  Aday yok (esik: n_aligned>=20 & lift>=5%)\n');
  } else {
    tops.forEach((s, i) => {
      console.log(`  ${i+1}. ${s.key}`);
      console.log(`     n_aligned=${s.n_aligned}  aligned_WR=%${s.aligned_wr_pct}  base_WR=%${s.baseline_wr_pct}  lift=+${s.lift_pct}%  z=${s.z_score}  ${s.classification}${s.significant?' (significant)':''}`);
      if (s.contrarian_lift_pct != null) {
        console.log(`     opposed_WR=%${s.opposed_wr_pct}  contrarian_lift=${s.contrarian_lift_pct}%`);
      }
    });
    console.log('');
  }

  // Anti-performers (counterproductive)
  const antis = allScores.filter(s => s.n_aligned >= 20 && s.lift_pct < -5);
  if (antis.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('   COUNTERPRODUCTIVE — promote ETMEYIN (negatif lift)');
    console.log('═══════════════════════════════════════════════════════════════════');
    antis.forEach(s => {
      console.log(`  ✗ ${s.key.padEnd(26)} n=${s.n_aligned} aligned_WR=%${s.aligned_wr_pct} lift=${s.lift_pct}% z=${s.z_score}`);
    });
    console.log('');
  }

  // Detay JSON dump
  const outPath = path.join(PROJECT_ROOT, 'scanner/data/learning/shadow-indicator-scores.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: {
      totalSignals: all.length,
      resolved: resolved.length,
      shadowEnabled: shadowEnabled.length,
      real: realResolved.length,
      virtual: virtualResolved.length,
    },
    real: realScores,
    virtual: virtScores,
    all: allScores,
    promotionCandidates: tops.map(s => s.key),
  }, null, 2));
  console.log(`Detay JSON: ${path.relative(PROJECT_ROOT, outPath)}`);
}

main();
