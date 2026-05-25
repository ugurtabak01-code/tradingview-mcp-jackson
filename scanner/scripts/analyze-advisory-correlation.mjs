#!/usr/bin/env node
/**
 * Advisory Kural Outcome Korelasyon Analizi
 *
 * 2026-05-02/03 patch'lerinde "advisory" yapilan 6 kural artik grade'e veya
 * SL/TP'ye dokunmuyor (sadece reasoning satirinda etiket olarak yaziyor).
 * Bu analiz son N gunluk resolved sinyalleri tarayip her advisory kosulun
 * outcome ile korelasyonunu olcer:
 *
 *   - Triggered group: reasoning patterninde advisory satir bulunan
 *   - Untriggered group: ayni grade/category havuzunda diger sinyaller
 *
 * Metrik: WR farki (triggered WR - untriggered WR), z-score, lift.
 *
 * Pozitif lift -> advisory triggered olunca WR yuksek (yani kosul iyi sinyali
 *                 isaretliyor). Bu, kuralin "engel" yerine "supporter" oldugunu
 *                 gosterir -> live'a almanin anlami yok.
 * Negatif lift -> advisory triggered olunca WR dusuk. Bu kosul bir "kotu sinyal
 *                 isaretci" -> live'a alip grade DUSURMEK degerli olabilir.
 * Sifira yakin -> noise, etkisiz, kaldirilabilir.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAllSignals, isResolved } from '../lib/learning/signal-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Geriye-donuk pencere
const WINDOW_DAYS = 14;

function computeZScore(p1, p0, n) {
  if (!Number.isFinite(p1) || !Number.isFinite(p0) || !n) return 0;
  const se = Math.sqrt(p0 * (1 - p0) / n);
  if (se === 0) return 0;
  return (p1 - p0) / se;
}

// Advisory tanimlari — pattern + aciklama + "live'a aldigimizda yapacagimiz aksiyon"
const ADVISORY_RULES = [
  {
    key: 'wrapper_reject',
    label: 'Rejim wrapper REJECT (REJECT_WARMUP / SUPPRESS vb.)',
    pattern: /\[Rejim wrapper\]\s+(REJECT|SUPPRESS)/i,
    proposedLiveAction: 'Wrapper reject olunca grade -> BEKLE (eski Faz 2 davranisi)',
  },
  {
    key: 'compute_regime_no_pos',
    label: 'computeRegime newPositionAllowed=false',
    pattern: /computeRegime\s+newPositionAllowed=false/i,
    proposedLiveAction: 'Rejim "new position" yasak diyor -> grade -> BEKLE',
  },
  {
    key: 'htf_counter_trend_advisory',
    label: 'HTF counter-trend (guven >=60) bilgi notu',
    pattern: /HTF counter-trend.*bilgi notu/i,
    proposedLiveAction: 'Conviction zaten ust satirda kirpiliyor — bu duplicate, kaldirilabilir',
  },
  {
    key: 'htf_gate_4h',
    label: 'HTF GATE [4H] — 1D teyidi zayif',
    pattern: /\bHTF GATE \[4H\].*1D teyidi zayif/i,
    proposedLiveAction: '4H sinyalde 1D teyidi yoksa grade 1 kademe dusur (B->C, A->B)',
  },
  {
    key: 'mtf_mixed',
    label: 'MTF uyumu %75 altinda (mixed)',
    pattern: /MTF uyumu %75 altinda.*advisory/i,
    proposedLiveAction: 'MTF mixed olunca grade 1 kademe dusur',
  },
  {
    key: 'per_symbol_autoflag',
    label: 'Per-symbol rule autoFlagged (gecmis WR dusuk)',
    pattern: /per-symbol rule \(autoFlagged\)/i,
    proposedLiveAction: 'autoFlagged sembolde grade -> BEKLE (eski hard gate)',
  },
];

function detectAdvisory(signal, pattern) {
  const reasoning = Array.isArray(signal.reasoning) ? signal.reasoning : [];
  return reasoning.some(r => pattern.test(r));
}

function analyzeRule(rule, signals) {
  let triggered = 0, triggeredWin = 0;
  let untriggered = 0, untriggeredWin = 0;
  const triggeredSamples = [];
  for (const s of signals) {
    const t = detectAdvisory(s, rule.pattern);
    if (t) {
      triggered++;
      if (s.win) triggeredWin++;
      triggeredSamples.push(s);
    } else {
      untriggered++;
      if (s.win) untriggeredWin++;
    }
  }
  const trigWR = triggered ? triggeredWin / triggered : null;
  const untrigWR = untriggered ? untriggeredWin / untriggered : null;
  const baseline = signals.length ? signals.filter(s => s.win).length / signals.length : 0;
  const lift = trigWR != null ? (trigWR - baseline) * 100 : null;
  // Triggered WR vs untriggered WR farki (advisory'nin gercek diskriminatif gucu)
  const discriminative = (trigWR != null && untrigWR != null) ? (trigWR - untrigWR) * 100 : null;
  const z = triggered >= 5 ? computeZScore(trigWR, baseline, triggered) : 0;
  const significant = triggered >= 15 && Math.abs(z) > 1.96; // single-test alpha=0.05

  // Recommendation logic
  let recommendation = 'INSUFFICIENT_DATA';
  if (triggered >= 15) {
    if (discriminative < -10 && significant) recommendation = 'PROMOTE_LIVE_DOWNGRADE';
    else if (discriminative < -5) recommendation = 'PRELIMINARY_PROMOTE';
    else if (Math.abs(discriminative) <= 3) recommendation = 'REMOVE_NOISE';
    else if (discriminative > 5) recommendation = 'PARADOXICAL_KEEP_AS_INFO';
    else recommendation = 'KEEP_AS_ADVISORY';
  } else if (triggered >= 5) {
    recommendation = 'PRELIMINARY_INSUFFICIENT';
  }

  return {
    rule: rule.label,
    key: rule.key,
    n_triggered: triggered,
    n_untriggered: untriggered,
    triggered_wr_pct: trigWR != null ? Math.round(trigWR * 1000) / 10 : null,
    untriggered_wr_pct: untrigWR != null ? Math.round(untrigWR * 1000) / 10 : null,
    baseline_wr_pct: Math.round(baseline * 1000) / 10,
    lift_vs_baseline_pct: lift != null ? Math.round(lift * 10) / 10 : null,
    discriminative_pct: discriminative != null ? Math.round(discriminative * 10) / 10 : null,
    z_score: Math.round(z * 100) / 100,
    significant,
    recommendation,
    proposedLiveAction: rule.proposedLiveAction,
    samples: triggeredSamples.slice(0, 3).map(s => ({
      symbol: s.symbol, tf: s.timeframe, grade: s.grade, win: s.win, status: s.status,
    })),
  };
}

function main() {
  const all = loadAllSignals();
  const resolved = all.filter(isResolved);
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  const recent = resolved.filter(s => {
    const t = new Date(s.resolvedAt || s.entryExpiredAt || s.updatedAt || s.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`   ADVISORY KURAL × OUTCOME KORELASYON (son ${WINDOW_DAYS}g)`);
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`Toplam sinyal           : ${all.length}`);
  console.log(`Resolved (win/loss)     : ${resolved.length}`);
  console.log(`Son ${WINDOW_DAYS} gun resolved : ${recent.length}`);
  const baselineWR = recent.length ? recent.filter(s => s.win).length / recent.length : 0;
  console.log(`Baseline WR            : %${Math.round(baselineWR * 1000) / 10}`);
  console.log('');

  // Real liga (A/B/C) on
  const real = recent.filter(s => ['A', 'B', 'C'].includes(s.grade));
  console.log(`---- GERCEK LIGA (A/B/C) — n=${real.length}, WR=%${real.length ? Math.round(real.filter(s=>s.win).length/real.length*1000)/10 : '-'} ----`);
  console.log('');

  const results = ADVISORY_RULES.map(r => analyzeRule(r, real));
  // Sirala: discriminative gucune gore (negatif lift onde = en cok bastirma adayi)
  results.sort((a, b) => {
    const da = a.discriminative_pct ?? 999;
    const db = b.discriminative_pct ?? 999;
    return da - db;
  });

  for (const r of results) {
    console.log(`▸ ${r.rule}`);
    console.log(`  n_triggered=${r.n_triggered}  n_untriggered=${r.n_untriggered}  base_WR=%${r.baseline_wr_pct}`);
    if (r.triggered_wr_pct != null) {
      console.log(`  triggered_WR=%${r.triggered_wr_pct}  untriggered_WR=%${r.untriggered_wr_pct}`);
      console.log(`  lift_vs_base=${r.lift_vs_baseline_pct >= 0 ? '+' : ''}${r.lift_vs_baseline_pct}%  discriminative=${r.discriminative_pct >= 0 ? '+' : ''}${r.discriminative_pct}%  z=${r.z_score}${r.significant ? ' *' : ''}`);
    } else {
      console.log(`  triggered_WR=- (hic veri yok)`);
    }
    console.log(`  → ${r.recommendation}`);
    console.log(`     teklif: ${r.proposedLiveAction}`);
    if (r.samples.length) {
      console.log(`     ornek: ${r.samples.map(x => `${x.symbol}/${x.tf}/${x.grade}=${x.win?'W':'L'}`).join(', ')}`);
    }
    console.log('');
  }

  // Sanal (BEKLE) ayri analiz
  const virt = recent.filter(s => s.grade === 'BEKLE');
  if (virt.length >= 10) {
    console.log(`---- SANAL (BEKLE) — n=${virt.length}, WR=%${Math.round(virt.filter(s=>s.win).length/virt.length*1000)/10} ----`);
    console.log('');
    const virtRes = ADVISORY_RULES.map(r => analyzeRule(r, virt));
    virtRes.sort((a, b) => (a.discriminative_pct ?? 999) - (b.discriminative_pct ?? 999));
    for (const r of virtRes) {
      if (r.n_triggered < 5) continue;
      console.log(`▸ ${r.rule}: n_trig=${r.n_triggered}  WR=%${r.triggered_wr_pct}  vs  WR_untrig=%${r.untriggered_wr_pct}  Δ=${r.discriminative_pct >= 0 ? '+' : ''}${r.discriminative_pct}%`);
    }
    console.log('');
  }

  // Save JSON
  const outPath = path.join(PROJECT_ROOT, 'scanner/data/learning/advisory-correlation.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    summary: {
      total: all.length,
      resolved: resolved.length,
      recent: recent.length,
      real: real.length,
      virtual: virt.length,
      baselineWR_pct: Math.round(baselineWR * 1000) / 10,
    },
    rules: results,
  }, null, 2));
  console.log(`Detay JSON: ${path.relative(PROJECT_ROOT, outPath)}`);
}

main();
