#!/usr/bin/env node
/**
 * backtest-admit-bekle.mjs
 *
 * Hipotez: grading, kazanan kurulumlari fazla reddediyor (virtual-alpha-inversion).
 * Bu script "ADMISSION" senaryolarini simule eder: belirli kriterlere uyan BEKLE
 * (reddedilmis) sinyalleri Real lige KABUL etseydik PnL ne olurdu?
 *
 * backtest-interventions.mjs sinyal ÇIKARMA test eder; bu script sinyal EKLEME
 * (veto gevsetme) test eder. Salt-okunur, canli karari ETKILEMEZ.
 *
 * Pozisyon: kabul edilen BEKLE sinyali icin varsayilan boyut C-lig (%50). Hem
 * %50 hem %100 senaryolari gosterilir (alt/ust sinir).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(ROOT, 'data/signals/archive');
const OPEN_PATH = path.join(ROOT, 'data/signals/open.json');

function loadAll() {
  let all = [];
  for (const f of ['2026-04.json', '2026-05.json']) {
    const p = path.join(ARCHIVE_DIR, f);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    all = all.concat(Array.isArray(d) ? d : (d.signals || Object.values(d)));
  }
  if (fs.existsSync(OPEN_PATH)) {
    const d = JSON.parse(fs.readFileSync(OPEN_PATH, 'utf8'));
    all = all.concat(Array.isArray(d) ? d : (d.signals || Object.values(d)));
  }
  return all.filter(s => s.actualRR != null && !s.dataContaminated);
}

const all = loadAll();
const real = all.filter(s => s.grade !== 'BEKLE');
const bekle = all.filter(s => s.grade === 'BEKLE');

function r(s) { return Number(s.actualRR) || 0; }
function realEffR(s) {
  const pct = (s.position_pct != null ? Number(s.position_pct) : 100) / 100;
  return r(s) * pct;
}
function wrOf(rows) { return rows.length ? 100 * rows.filter(s => r(s) > 0).length / rows.length : 0; }
function sumR(rows, pct) { return rows.reduce((a, s) => a + r(s) * pct, 0); }

// --- Aday admission kohortlari (analiz bulgulari) ---
const hasMtfVeto = (s) =>
  (s.warnings || []).some(w => /Yuksek TF trend|MTF celiski|HTF gate/i.test(String(w)));
const convBucket46 = (s) => { const c = s.tally?.conviction; return c != null && c >= 4 && c < 6; };
const isBist = (s) => s.category === 'bist';

const COHORTS = [
  { name: 'MTF/HTF counter-trend veto', match: hasMtfVeto },
  { name: 'conviction 4-6', match: convBucket46 },
  { name: 'bist kategori', match: isBist },
  { name: 'MTF-veto VEYA conv4-6', match: s => hasMtfVeto(s) || convBucket46(s) },
];

// --- Baseline ---
const baseReal = real.reduce((a, s) => a + realEffR(s), 0);
console.log('='.repeat(72));
console.log('ADMISSION BACKTEST — reddedilen (BEKLE) sinyalleri Real lige kabul etsek?');
console.log('='.repeat(72));
console.log(`Veri: 2026-04 + 2026-05 + open  |  Real n=${real.length}  BEKLE n=${bekle.length}`);
console.log(`\nBASELINE Real lig: sumR(effective)=${baseReal.toFixed(2)}R  WR=${wrOf(real).toFixed(1)}%  avgR=${(baseReal/real.length).toFixed(3)}`);
console.log(`(referans) Tum BEKLE: WR=${wrOf(bekle).toFixed(1)}%  ham sumR=${sumR(bekle,1).toFixed(2)}R  n=${bekle.length}`);

console.log('\n## Kohort bazinda: bu BEKLE sinyalleri kabul edersek ne eklenir?');
console.log(`${'kohort'.padEnd(30)} n   WR     +sumR@50%  +sumR@100%`);
for (const c of COHORTS) {
  const rows = bekle.filter(c.match);
  if (!rows.length) { console.log(`${c.name.padEnd(30)}  0   -`); continue; }
  console.log(
    `${c.name.padEnd(30)}${String(rows.length).padStart(3)}  ${wrOf(rows).toFixed(1).padStart(5)}%  ` +
    `${('+' + sumR(rows, 0.5).toFixed(2)).padStart(8)}R  ${('+' + sumR(rows, 1).toFixed(2)).padStart(8)}R`
  );
}

console.log('\n## Blended sonuc: Real lig + kabul edilen kohort (C-lig %50 boyut)');
console.log(`${'senaryo'.padEnd(34)} n     WR      sumR     avgR     Δ vs base`);
const baseAvg = baseReal / real.length;
function blendedRow(name, cohortRows) {
  const n = real.length + cohortRows.length;
  const s = baseReal + sumR(cohortRows, 0.5);
  const allRows = real.concat(cohortRows);
  const w = wrOf(allRows);
  const avg = s / n;
  console.log(
    `${name.padEnd(34)}${String(n).padStart(4)}  ${w.toFixed(1).padStart(5)}%  ${s.toFixed(2).padStart(7)}R  ` +
    `${avg.toFixed(3).padStart(6)}  ${((s - baseReal) >= 0 ? '+' : '') + (s - baseReal).toFixed(2)}R`
  );
}
blendedRow('BASELINE (admission yok)', []);
for (const c of COHORTS) blendedRow('+ ' + c.name, bekle.filter(c.match));

console.log('\n## Kabul edilen kohortta kaybedenlerin dagilimi (risk kontrolu)');
for (const c of COHORTS) {
  const rows = bekle.filter(c.match);
  const losers = rows.filter(s => r(s) <= 0);
  const lossR = sumR(losers, 1);
  console.log(`  ${c.name.padEnd(30)} kaybeden=${losers.length}/${rows.length}  kayip ham R=${lossR.toFixed(2)}`);
}

console.log('\nNot: actualRR, BEKLE sinyali sanal izlenirken hesaplandi; canli yonetimde');
console.log('(trailing/BE) sonuc biraz farkli olabilir. avgR artisi + makul WR + sinirli');
console.log('kayip = veto gevsetme adayidir. Sonraki adim: grader veto kosulunu daralt.');
