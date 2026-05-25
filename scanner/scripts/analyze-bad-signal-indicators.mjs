#!/usr/bin/env node
/**
 * Kotu sinyal -> indikator korelasyonu analizi.
 *
 * "Kotu sinyal" tanimi: entryHit=true, resolved, tp1Hit=false (TP1 bile alamadan kapandi).
 * "Iyi sinyal": entryHit=true, resolved, tp1Hit=true.
 *
 * Her kategori (crypto / us_stock / bist / commodity / forex) icin her indikator
 * (voteBreakdown + shadowVotes source'lari) sinyalin yonunde oy verdiginde
 * kotu sinyallerle ne kadar ortaklasiyor olcer.
 *
 * Kullanim:
 *   node scripts/analyze-bad-signal-indicators.mjs            # tum May verisi
 *   node scripts/analyze-bad-signal-indicators.mjs --since 2026-05-14
 */
import { loadAllSignals, isNeutralStatus } from '../lib/learning/signal-loader.js';

// --since dogrulamasi: degersiz veya gecersiz tarih sessizce 0 sonuc vermesin.
const sinceArg = process.argv.indexOf('--since');
let sinceTs = 0;
if (sinceArg > -1) {
  const raw = process.argv[sinceArg + 1];
  const parsed = raw ? new Date(raw + 'T00:00:00Z').getTime() : NaN;
  if (!Number.isFinite(parsed)) {
    console.error(`HATA: --since gecersiz tarih: "${raw ?? ''}" (beklenen format: YYYY-MM-DD)`);
    process.exit(1);
  }
  sinceTs = parsed;
}

const all = loadAllSignals({ dedupe: true });
// "Kotu sinyal" analizi gercek win/loss outcome'u olan sinyalleri inceler.
// Notr statuslu sinyaller (superseded_*, entry_expired, entry_missed_tp,
// invalid_data, manual_close) iptal edilmistir — TP1 alamamis olmalari onlari
// "kotu sinyal" yapmaz; analizden cikarilir.
const resolved = all.filter(s =>
  s.resolvedAt && s.entryHit && !isNeutralStatus(s) &&
  new Date(s.resolvedAt).getTime() >= sinceTs
);

console.log(`\n=== KOTU SINYAL / INDIKATOR ANALIZI ===`);
console.log(`Pencere: ${sinceArg > -1 ? '>= ' + process.argv[sinceArg + 1] : 'tum arsiv (open+archive)'}`);
console.log(`Toplam resolved + entryHit sinyal: ${resolved.length}\n`);

// indikator yon oyu cek (voteBreakdown gercek, shadowVotes golge)
function votesOf(sig) {
  const m = {};
  for (const v of (sig.voteBreakdown || [])) m[v.source] = { dir: v.direction, weight: v.weight, real: true };
  for (const v of (sig.shadowVotes || [])) if (!m[v.source]) m[v.source] = { dir: v.direction, weight: v.weight, real: false };
  return m;
}

const cats = {};
for (const s of resolved) {
  const c = s.category || 'unknown';
  (cats[c] = cats[c] || []).push(s);
}

for (const [cat, sigs] of Object.entries(cats).sort((a, b) => b[1].length - a[1].length)) {
  const bad = sigs.filter(s => !s.tp1Hit);
  const good = sigs.filter(s => s.tp1Hit);
  const slPure = sigs.filter(s => s.outcome === 'sl_hit' || s.outcome === 'sl_hit_high_mfe');
  console.log(`\n${'='.repeat(64)}`);
  console.log(`KATEGORI: ${cat.toUpperCase()}  | toplam ${sigs.length} | TP1-fail ${bad.length} (${pct(bad.length, sigs.length)}) | sl_hit ${slPure.length}`);
  console.log(`${'='.repeat(64)}`);
  if (bad.length < 3) { console.log('  (yetersiz kotu sinyal ornegi — atlandi)'); continue; }

  // tum indikator source'lari
  const sources = new Set();
  for (const s of sigs) { for (const k of Object.keys(votesOf(s))) sources.add(k); }

  const rows = [];
  for (const src of sources) {
    let badAgree = 0, badSeen = 0, goodAgree = 0, goodSeen = 0;
    for (const s of bad) {
      const v = votesOf(s)[src]; if (!v) continue; badSeen++;
      if (v.dir && v.dir === s.direction) badAgree++;
    }
    for (const s of good) {
      const v = votesOf(s)[src]; if (!v) continue; goodSeen++;
      if (v.dir && v.dir === s.direction) goodAgree++;
    }
    if (badSeen < 3) continue;
    const badRate = badAgree / badSeen;
    const goodRate = goodSeen ? goodAgree / goodSeen : 0;
    // indikator sinyalle hemfikir oldugunda kazanma orani
    const agreeWin = badAgree + goodAgree > 0 ? goodAgree / (badAgree + goodAgree) : null;
    rows.push({
      src,
      real: votesOf(bad.find(s => votesOf(s)[src]))[src]?.real,
      badAgree, badSeen, goodAgree, goodSeen,
      badRate, goodRate,
      lift: badRate - goodRate,        // + ise kotu sinyalleri daha cok itiyor
      agreeWin,
    });
  }

  // En cok "kotu sinyali itekleyen" indikatorler (lift buyuk + kotu sinyalde sik hemfikir)
  rows.sort((a, b) => b.lift - a.lift);
  console.log(`\n  [SUCLU INDIKATORLER] — kotu sinyallerde iyi sinyallere gore daha sik sinyal yonunde oy verenler`);
  console.log(`  ${'indikator'.padEnd(22)} ${'tip'.padEnd(7)} kotu-uyum   iyi-uyum   lift    hemfikir-WR`);
  for (const r of rows.slice(0, 8)) {
    console.log(`  ${r.src.padEnd(22)} ${(r.real ? 'real' : 'shadow').padEnd(7)} ` +
      `${fmtRate(r.badAgree, r.badSeen).padEnd(11)} ${fmtRate(r.goodAgree, r.goodSeen).padEnd(10)} ` +
      `${(r.lift >= 0 ? '+' : '') + (r.lift * 100).toFixed(0).padStart(3)}%   ` +
      `${r.agreeWin == null ? '-' : (r.agreeWin * 100).toFixed(0) + '%'}`);
  }

  // En dusuk hemfikir-WR (sinyalle ayni yonde oy verdiginde en cok kaybettiren)
  const byWin = rows.filter(r => r.badAgree + r.goodAgree >= 5).sort((a, b) => a.agreeWin - b.agreeWin);
  console.log(`\n  [DUSUK GUVENILIRLIK] — bu indikator sinyal yonunde oy verince WR (en kotu 6)`);
  for (const r of byWin.slice(0, 6)) {
    console.log(`  ${r.src.padEnd(22)} hemfikir-WR ${(r.agreeWin * 100).toFixed(0)}%  (${r.goodAgree}W / ${r.badAgree}L)`);
  }
}

// rejim / grade / timeframe kesiti
console.log(`\n\n${'='.repeat(64)}`);
console.log(`GENEL KESITLER (tum kategoriler)`);
console.log(`${'='.repeat(64)}`);
for (const dim of ['regime', 'grade', 'timeframe', 'direction']) {
  const g = {};
  for (const s of resolved) {
    const k = String(s[dim] ?? '?');
    g[k] = g[k] || { n: 0, bad: 0 };
    g[k].n++; if (!s.tp1Hit) g[k].bad++;
  }
  console.log(`\n  ${dim}:`);
  for (const [k, v] of Object.entries(g).sort((a, b) => b[1].n - a[1].n)) {
    if (v.n < 4) continue;
    console.log(`    ${k.padEnd(20)} n=${String(v.n).padStart(3)}  TP1-fail ${pct(v.bad, v.n)}`);
  }
}

// numerik indikator degerleri: kotu vs iyi sinyalde ortalama
console.log(`\n\n${'='.repeat(64)}`);
console.log(`NUMERIK INDIKATOR DEGERLERI (entry aninda) — kotu vs iyi ortalama`);
console.log(`${'='.repeat(64)}`);
const numPaths = {
  'khanSaab.rsi': s => s.indicators?.khanSaab?.rsi,
  'khanSaab.adx': s => s.indicators?.khanSaab?.adx,
  'khanSaab.adxSlope': s => s.indicators?.khanSaab?.adxSlope,
  'cdv.buyRatio': s => s.indicators?.cdv?.buyRatio,
  'rr': s => s.rr,
  'htfConfidence': s => s.htfConfidence,
  'mtfAlignment': s => s.mtfAlignment,
};
for (const [cat, sigs] of Object.entries(cats)) {
  const bad = sigs.filter(s => !s.tp1Hit), good = sigs.filter(s => s.tp1Hit);
  if (bad.length < 3 || good.length < 3) continue;
  console.log(`\n  ${cat.toUpperCase()}`);
  for (const [name, fn] of Object.entries(numPaths)) {
    const mean = arr => { const v = arr.map(fn).filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const mb = mean(bad), mg = mean(good);
    if (mb == null || mg == null) continue;
    const flag = Math.abs(mb - mg) / (Math.abs(mg) || 1) > 0.15 ? '  <-- FARK' : '';
    console.log(`    ${name.padEnd(20)} kotu ${mb.toFixed(2).padStart(8)} | iyi ${mg.toFixed(2).padStart(8)}${flag}`);
  }
}

function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '-'; }
function fmtRate(a, b) { return b ? `${a}/${b} ${Math.round(a / b * 100)}%` : '-'; }
