#!/usr/bin/env node
/**
 * KRIPTO INDIKATOR VERIMLILIK ANALIZI
 *
 * Sadece kripto kategorisindeki resolved sinyalleri tarar. Her oylamaya katilan
 * indikator icin:
 *   - aligned: vote.direction == signal.direction → WR
 *   - opposed: vote.direction != signal.direction → WR
 *   - absent:  o sinyalde o indikator hic oy uretmemis
 *
 * Metrikler:
 *   - aligned_WR, opposed_WR, absent_WR, baseline_WR
 *   - lift_vs_baseline = aligned_WR - baseline_WR
 *   - discriminative   = aligned_WR - opposed_WR  (kuvvetli pozitif → indikator
 *                        gerçekten yön bildiriyor; sifira yakin → noise)
 *   - z_score (single-test alpha=0.05, |z|>1.96 anlamli)
 *
 * Cikis: lift'e gore sirali tablo + verimlilik sinifi (yuksek/orta/dusuk/zararli).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAllSignals, isResolved } from '../lib/learning/signal-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const CRYPTO_CATEGORIES = new Set(['crypto', 'kripto']);

function isCrypto(s) {
  return CRYPTO_CATEGORIES.has(String(s.category || '').toLowerCase());
}

function computeZScore(p1, p0, n) {
  if (!Number.isFinite(p1) || !Number.isFinite(p0) || !n) return 0;
  const se = Math.sqrt(p0 * (1 - p0) / n);
  if (se === 0) return 0;
  return (p1 - p0) / se;
}

function classifyVote(signal, indicatorKey) {
  const vb = Array.isArray(signal.voteBreakdown) ? signal.voteBreakdown : [];
  // Indikator bu sinyalde hic vote etmis mi?
  const matches = vb.filter(v => v.source === indicatorKey);
  if (matches.length === 0) return 'absent';
  // Birden fazla varyant olabilir (rsi_level long + ema_cross short vb. degil — ayni source aslinda tek olur).
  // Yine de bir tanesi yon vermisse alignment'a bakariz; yonsuz (amplifier) iseler 'amplifier' say.
  const dirVote = matches.find(v => v.direction === 'long' || v.direction === 'short');
  if (!dirVote) return 'amplifier'; // direction:null vote (amplifier kind)
  return dirVote.direction === signal.direction ? 'aligned' : 'opposed';
}

function scoreIndicator(key, signals) {
  const aligned = [];
  const opposed = [];
  const amplifier = [];
  const absent = [];
  for (const s of signals) {
    const c = classifyVote(s, key);
    if (c === 'aligned') aligned.push(s);
    else if (c === 'opposed') opposed.push(s);
    else if (c === 'amplifier') amplifier.push(s);
    else absent.push(s);
  }
  const wr = arr => arr.length ? arr.filter(s => s.win).length / arr.length : null;
  const alignedWR = wr(aligned);
  const opposedWR = wr(opposed);
  const amplifierWR = wr(amplifier);
  const absentWR = wr(absent);
  const baseline = signals.length ? signals.filter(s => s.win).length / signals.length : 0;
  const lift = alignedWR != null ? (alignedWR - baseline) * 100 : null;
  const discriminative = (alignedWR != null && opposedWR != null)
    ? (alignedWR - opposedWR) * 100 : null;
  const contrarianLift = opposedWR != null ? (opposedWR - baseline) * 100 : null;
  const z = aligned.length >= 5 ? computeZScore(alignedWR, baseline, aligned.length) : 0;
  const significant = aligned.length >= 20 && Math.abs(z) > 1.96;

  // Verimlilik sinifi
  let efficiency = 'insufficient';
  if (aligned.length >= 20) {
    if (discriminative == null) {
      // opposed oy yok — diskriminatif guc olculemiyor, daha fazla veri gerek
      efficiency = 'preliminary';
    } else if (discriminative >= 15 && significant) efficiency = 'YUKSEK';
    else if (discriminative >= 5) efficiency = 'orta';
    else if (Math.abs(discriminative) < 5) efficiency = 'dusuk_noise';
    else efficiency = 'ZARARLI'; // discriminative < -5 (opposed > aligned)
  } else if (aligned.length >= 10) {
    efficiency = 'preliminary';
  }

  return {
    key,
    n_total: signals.length,
    n_aligned: aligned.length,
    n_opposed: opposed.length,
    n_amplifier: amplifier.length,
    n_absent: absent.length,
    aligned_wr_pct: alignedWR != null ? Math.round(alignedWR * 1000) / 10 : null,
    opposed_wr_pct: opposedWR != null ? Math.round(opposedWR * 1000) / 10 : null,
    amplifier_wr_pct: amplifierWR != null ? Math.round(amplifierWR * 1000) / 10 : null,
    absent_wr_pct: absentWR != null ? Math.round(absentWR * 1000) / 10 : null,
    baseline_wr_pct: Math.round(baseline * 1000) / 10,
    lift_pct: lift != null ? Math.round(lift * 10) / 10 : null,
    discriminative_pct: discriminative != null ? Math.round(discriminative * 10) / 10 : null,
    contrarian_lift_pct: contrarianLift != null ? Math.round(contrarianLift * 10) / 10 : null,
    z_score: Math.round(z * 100) / 100,
    significant,
    efficiency,
  };
}

function main() {
  const all = loadAllSignals();
  const resolved = all.filter(isResolved);
  const crypto = resolved.filter(isCrypto);
  const real = crypto.filter(s => ['A', 'B', 'C'].includes(s.grade));
  const virtual = crypto.filter(s => s.grade === 'BEKLE');
  const baselineWR = real.length ? real.filter(s => s.win).length / real.length : 0;

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('   KRIPTO INDIKATOR VERIMLILIK ANALIZI');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`Toplam resolved sinyal           : ${resolved.length}`);
  console.log(`Kripto resolved                  : ${crypto.length}`);
  console.log(`  • Gercek liga (A/B/C)          : ${real.length}  (WR=%${Math.round(baselineWR*1000)/10})`);
  console.log(`  • Sanal (BEKLE)                : ${virtual.length}`);
  console.log('');

  // Symbol coverage
  const symbols = new Set(crypto.map(s => s.symbol));
  console.log(`Kripto sembol kapsami            : ${symbols.size} sembol`);
  console.log(`  ornek: ${Array.from(symbols).slice(0, 10).join(', ')}${symbols.size > 10 ? '...' : ''}`);
  console.log('');

  // Tum unique vote source key'lerini topla (voteBreakdown'dan)
  const allSources = new Set();
  for (const s of real) {
    if (Array.isArray(s.voteBreakdown)) {
      for (const v of s.voteBreakdown) if (v.source) allSources.add(v.source);
    }
  }
  const sourceList = Array.from(allSources).sort();

  if (real.length === 0) {
    console.log('Gercek liga sinyal yok — analiz yapilamaz.');
    return;
  }

  // Score tum indikatorler
  const scores = sourceList.map(k => scoreIndicator(k, real));
  // Lift'e gore sirala (en yuksek pozitif onde)
  scores.sort((a, b) => (b.lift_pct ?? -999) - (a.lift_pct ?? -999));

  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log(`  TUM INDIKATORLER — GERCEK LIGA (n=${real.length}, baseline WR=%${Math.round(baselineWR*1000)/10})`);
  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log('  KEY                       N_ALN  ALN_WR   OPP_WR  ABS_WR  LIFT   DISCR  Z      SINIF');
  for (const s of scores) {
    const k = s.key.padEnd(25);
    const n = String(s.n_aligned).padStart(5);
    const a = (s.aligned_wr_pct != null ? '%'+s.aligned_wr_pct : '  -  ').toString().padStart(7);
    const o = (s.opposed_wr_pct != null ? '%'+s.opposed_wr_pct : '  -  ').toString().padStart(7);
    const ab = (s.absent_wr_pct != null ? '%'+s.absent_wr_pct : '  -  ').toString().padStart(7);
    const l = (s.lift_pct != null ? (s.lift_pct>=0?'+':'')+s.lift_pct : '  -  ').toString().padStart(7);
    const dr = (s.discriminative_pct != null ? (s.discriminative_pct>=0?'+':'')+s.discriminative_pct : '  -  ').toString().padStart(7);
    const z = String(s.z_score).padStart(6);
    const c = s.efficiency + (s.significant ? ' *' : '');
    console.log(`  ${k} ${n} ${a} ${o} ${ab} ${l} ${dr} ${z}  ${c}`);
  }
  console.log('');

  // Kategorize
  const yuksek = scores.filter(s => s.efficiency === 'YUKSEK');
  const orta = scores.filter(s => s.efficiency === 'orta');
  const dusuk = scores.filter(s => s.efficiency === 'dusuk_noise');
  const zararli = scores.filter(s => s.efficiency === 'ZARARLI');
  const prelim = scores.filter(s => s.efficiency === 'preliminary');
  const insuf = scores.filter(s => s.efficiency === 'insufficient');

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('   VERIMLILIK SINIF OZETLERI');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`  🟢 YUKSEK    (n>=20, discr>=+15%, anlamli) — agirligi ARTIR  : ${yuksek.length}`);
  yuksek.forEach(s => console.log(`     • ${s.key.padEnd(25)} aligned WR %${s.aligned_wr_pct} | discr +${s.discriminative_pct}% | n=${s.n_aligned}`));
  console.log(`  🔵 orta      (n>=20, +5%<=discr<+15%) — KORU                : ${orta.length}`);
  orta.forEach(s => console.log(`     • ${s.key.padEnd(25)} aligned WR %${s.aligned_wr_pct} | discr +${s.discriminative_pct}% | n=${s.n_aligned}`));
  console.log(`  ⚪ dusuk_noise (n>=20, |discr|<5%) — agirligi AZALT veya KALDIR : ${dusuk.length}`);
  dusuk.forEach(s => console.log(`     • ${s.key.padEnd(25)} aligned WR %${s.aligned_wr_pct} | discr ${s.discriminative_pct >= 0 ? '+' : ''}${s.discriminative_pct}% | n=${s.n_aligned}`));
  console.log(`  🔴 ZARARLI   (n>=20, discr<-5%) — agirligi DUSUR/SIFIRLA   : ${zararli.length}`);
  zararli.forEach(s => console.log(`     • ${s.key.padEnd(25)} aligned WR %${s.aligned_wr_pct} | opposed %${s.opposed_wr_pct} | discr ${s.discriminative_pct}% | n=${s.n_aligned}`));
  console.log(`  ◆ preliminary (10<=n<20) — VERI BIRIKTIR                    : ${prelim.length}`);
  prelim.forEach(s => console.log(`     • ${s.key.padEnd(25)} n=${s.n_aligned} discr=${s.discriminative_pct >= 0 ? '+' : ''}${s.discriminative_pct ?? '-'}%`));
  console.log(`  ◇ insufficient (n<10) — gozlem yetersiz                   : ${insuf.length}`);
  insuf.forEach(s => console.log(`     • ${s.key.padEnd(25)} n=${s.n_aligned}`));
  console.log('');

  // Save JSON
  const outPath = path.join(PROJECT_ROOT, 'scanner/data/learning/crypto-indicator-efficiency.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    category: 'crypto',
    summary: {
      totalResolved: resolved.length,
      cryptoResolved: crypto.length,
      cryptoReal: real.length,
      cryptoVirtual: virtual.length,
      symbolCoverage: symbols.size,
      baselineWR_pct: Math.round(baselineWR * 1000) / 10,
    },
    indicators: scores,
    classification: {
      yuksek: yuksek.map(s => s.key),
      orta: orta.map(s => s.key),
      dusuk_noise: dusuk.map(s => s.key),
      zararli: zararli.map(s => s.key),
      preliminary: prelim.map(s => s.key),
      insufficient: insuf.map(s => s.key),
    },
  }, null, 2));
  console.log(`Detay JSON: ${path.relative(PROJECT_ROOT, outPath)}`);
}

main();
