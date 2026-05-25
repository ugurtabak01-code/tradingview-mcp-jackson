#!/usr/bin/env node
/**
 * analyze-virtual-alpha-segments.mjs
 *
 * "virtual_alpha_inversion" advisory'sinin kaynagini bul: reddedilen (BEKLE)
 * lig neden Real ligadan yuksek WR uretiyor? Hangi segmentte / hangi veto
 * kurali yuzunden iyi setup'lar eleniyor?
 *
 * Cikti: Real vs BEKLE WR/PF/n karsilastirmasi + segment kirilimlari + reddedilen
 * kazananlarin (false-negative) profili. Salt-okunur, canli karari ETKILEMEZ.
 *
 * Kullanim:  node scripts/analyze-virtual-alpha-segments.mjs [--min-n=5]
 */

import { readAllArchives } from '../lib/learning/persistence.js';
import { classifyOutcome } from '../lib/learning/ladder-engine.js';

const argMinN = Number((process.argv.find(a => a.startsWith('--min-n=')) || '').split('=')[1]) || 5;

function isWinLoss(s) {
  const cls = classifyOutcome(s.status || s.outcome);
  return cls === 'win' || cls === 'loss';
}

function wr(rows) {
  if (!rows.length) return null;
  return (rows.filter(s => s.win).length / rows.length) * 100;
}

function pf(rows) {
  const withRR = rows.filter(s => s.actualRR != null);
  if (!withRR.length) return null;
  const gw = withRR.filter(s => s.win).reduce((a, s) => a + s.actualRR, 0);
  const gl = Math.abs(withRR.filter(s => !s.win).reduce((a, s) => a + s.actualRR, 0));
  return gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
}

function fmt(v, d = 1) {
  if (v == null) return '  -  ';
  if (!isFinite(v)) return ' inf ';
  return v.toFixed(d).padStart(5);
}

function line(label, rows) {
  const w = wr(rows);
  const p = pf(rows);
  return `${label.padEnd(22)} n=${String(rows.length).padStart(4)}  WR=${fmt(w)}%  PF=${fmt(p, 2)}`;
}

/** Bir alana gore grupla, real-vs-bekle WR farkini cikar (yalniz min-n ustu). */
function segmentTable(real, bekle, keyFn, title) {
  const keys = new Set([...real, ...bekle].map(keyFn));
  const rows = [];
  for (const k of keys) {
    const r = real.filter(s => keyFn(s) === k);
    const b = bekle.filter(s => keyFn(s) === k);
    if (r.length < argMinN && b.length < argMinN) continue;
    const rw = wr(r), bw = wr(b);
    const gap = (rw != null && bw != null) ? bw - rw : null;
    rows.push({ k, r, b, rw, bw, gap });
  }
  rows.sort((a, b) => (b.gap ?? -999) - (a.gap ?? -999));
  console.log(`\n## ${title}  (BEKLE WR - Real WR, yuksek = grading bu segmentte iyi setup eliyor)`);
  console.log(`${'segment'.padEnd(22)}  Real(n/WR)        BEKLE(n/WR)       gap`);
  for (const { k, r, b, rw, bw, gap } of rows) {
    console.log(
      `${String(k).padEnd(22)}  ${String(r.length).padStart(4)}/${fmt(rw)}%   ` +
      `${String(b.length).padStart(4)}/${fmt(bw)}%   ${gap == null ? '  -' : (gap >= 0 ? '+' : '') + gap.toFixed(1) + 'p'}`
    );
  }
}

function convictionBucket(s) {
  const c = s.tally?.conviction;
  if (c == null) return 'conv:?';
  if (c < 4) return 'conv:<4';
  if (c < 6) return 'conv:4-6';
  if (c < 8) return 'conv:6-8';
  return 'conv:>=8';
}

// --- yukle ---
const all = readAllArchives().filter(s => s.win != null && isWinLoss(s) && !s.dataContaminated);
const real = all.filter(s => s.grade !== 'BEKLE');
const bekle = all.filter(s => s.grade === 'BEKLE');

console.log('='.repeat(70));
console.log('VIRTUAL-ALPHA SEGMENT ANALIZI');
console.log('='.repeat(70));
console.log(line('REAL lig (A/B/C)', real));
console.log(line('BEKLE lig (rejected)', bekle));
const gw = wr(bekle), rw = wr(real);
if (gw != null && rw != null) {
  console.log(`\n>> Genel virtual-alpha gap: BEKLE %${gw.toFixed(1)} - Real %${rw.toFixed(1)} = ${(gw - rw >= 0 ? '+' : '')}${(gw - rw).toFixed(1)}p`);
}

segmentTable(real, bekle, s => s.regime || 'regime:?', 'Rejim bazinda');
segmentTable(real, bekle, s => s.category || 'cat:?', 'Kategori bazinda');
segmentTable(real, bekle, s => `tf:${s.timeframe ?? '?'}`, 'Timeframe bazinda');
segmentTable(real, bekle, s => `dir:${s.direction || '?'}`, 'Yon bazinda');
segmentTable(real, bekle, convictionBucket, 'Conviction kovasi bazinda');

// --- Reddedilen kazananlarin warning profili (false-negative suruculeri) ---
console.log('\n## Reddedilen KAZANAN (BEKLE & win) sinyallerinde warning tokenleri');
console.log('   (yuksek frekans = bu veto/uyari iyi setup\'lari sistematik eliyor olabilir)');
const bekleWinners = bekle.filter(s => s.win);
const tokenCount = new Map();
for (const s of bekleWinners) {
  for (const w of (s.warnings || [])) {
    const token = String(w).split(/[:—\-\[]/)[0].trim().slice(0, 40) || '(bos)';
    tokenCount.set(token, (tokenCount.get(token) || 0) + 1);
  }
}
const sorted = [...tokenCount.entries()].sort((a, b) => b[1] - a[1]);
console.log(`   reddedilen kazanan sayisi: ${bekleWinners.length}`);
for (const [tok, n] of sorted.slice(0, 15)) {
  console.log(`   ${String(n).padStart(4)}  ${tok}`);
}

console.log('\nNot: gap yuksek + n yeterli segmentler grading kalibrasyonu icin onceliklidir.');
console.log('Sonraki adim: aday kurali backtest-interventions.mjs ile dogrula, sonra grader esik/oy/veto ayarla.');
