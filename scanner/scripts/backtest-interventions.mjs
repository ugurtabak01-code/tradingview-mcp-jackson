#!/usr/bin/env node
/**
 * backtest-interventions.mjs
 *
 * Geçmiş kapanmış sinyaller üzerinde 3 müdahale senaryosunu simüle eder:
 *   A) trending_down rejiminde sinyal üretme
 *   B) us_stock + short kombinasyonunu filtrele
 *   C) A_min eşiğini yükselt (conviction >= 8.5 değilse A → B downgrade etkisi:
 *      basitleştirme — eski A grade sinyallerden conviction < 8.5 olanları iptal et)
 *   D) Üçü birlikte
 *
 * Karşılaştırma: baseline gerçek PnL vs senaryo PnL (R cinsinden).
 * Pozisyon büyüklüğü (position_pct) dikkate alınır — A=100, B=70, C=50 vb.
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
  return all.filter(s => s.actualRR != null);
}

function effectiveR(s) {
  // R-katsayısı pozisyon büyüklüğüne göre ölçeklenir.
  // position_pct null/yoksa 100 say (ladder pozisyon: real lig).
  const r = Number(s.actualRR) || 0;
  const pct = (s.position_pct != null ? Number(s.position_pct) : 100) / 100;
  return r * pct;
}

function summarize(signals, label) {
  const n = signals.length;
  const sumR = signals.reduce((s, x) => s + effectiveR(x), 0);
  const wins = signals.filter(s => Number(s.actualRR) > 0).length;
  const wr = n ? (100 * wins / n) : 0;
  return { label, n, wr, sumR, avgR: n ? sumR / n : 0 };
}

function byKey(signals, fn) {
  const groups = {};
  for (const s of signals) {
    const k = fn(s);
    if (!groups[k]) groups[k] = [];
    groups[k].push(s);
  }
  return groups;
}

function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.h.length, ...rows.map(r => String(r[c.k] ?? '').length)));
  const sep = (ch = ' ') => widths.map(w => ch.repeat(w)).join('  ');
  console.log(cols.map((c, i) => c.h.padEnd(widths[i])).join('  '));
  console.log(sep('-'));
  for (const r of rows) {
    console.log(cols.map((c, i) => String(r[c.k] ?? '').padEnd(widths[i])).join('  '));
  }
}

// --- Filtreler (her biri true dönerse sinyal İPTAL edilir / portföyden çıkarılır) ---
function filterTrendingDown(s) {
  return s.regime === 'trending_down';
}

function filterUsStockShort(s) {
  return s.category === 'us_stock' && s.direction === 'short';
}

function filterAGradeLowConviction(s) {
  // A grade ama conviction < 8.5 → iptal
  // (mevcut A_min=7, yeni A_min=8.5 önerisi)
  if (s.grade !== 'A') return false;
  const conv = s.tally?.conviction;
  if (conv == null) return false; // bilgi yoksa dokunma
  return conv < 8.5;
}

const SCENARIOS = [
  { name: 'BASELINE', filters: [] },
  { name: 'A: trending_down OFF', filters: [filterTrendingDown] },
  { name: 'B: us_stock short OFF', filters: [filterUsStockShort] },
  { name: 'C: A_min 7 → 8.5', filters: [filterAGradeLowConviction] },
  { name: 'D: A+B+C combined', filters: [filterTrendingDown, filterUsStockShort, filterAGradeLowConviction] },
];

function applyScenario(signals, filters) {
  if (!filters.length) return signals;
  return signals.filter(s => !filters.some(f => f(s)));
}

// --- Main ---
const all = loadAll();
console.log(`\n=== BACKTEST: Müdahale Senaryoları ===`);
console.log(`Toplam kapanmış sinyal: ${all.length}`);
console.log(`Veri penceresi: 2026-04 + 2026-05 + open\n`);

const results = [];
for (const sc of SCENARIOS) {
  const kept = applyScenario(all, sc.filters);
  const removed = all.length - kept.length;
  const summary = summarize(kept, sc.name);
  summary.removed = removed;
  results.push(summary);
}

console.log('=== Genel karşılaştırma ===');
table(results.map(r => ({
  scenario: r.label,
  n: r.n,
  removed: r.removed,
  WR: r.wr.toFixed(1) + '%',
  sumR: r.sumR.toFixed(2),
  avgR: r.avgR.toFixed(3),
  vsBase: (r.sumR - results[0].sumR).toFixed(2) + 'R',
})), [
  { h: 'Senaryo', k: 'scenario' },
  { h: 'n', k: 'n' },
  { h: 'iptal', k: 'removed' },
  { h: 'WR', k: 'WR' },
  { h: 'sumR', k: 'sumR' },
  { h: 'avgR', k: 'avgR' },
  { h: 'Δ vs Baseline', k: 'vsBase' },
]);

// --- Senaryo D'nin kategori kırılımı ---
console.log('\n=== Senaryo D — kategori × direction kırılımı ===');
const dSignals = applyScenario(all, SCENARIOS[4].filters);
const groups = byKey(dSignals, s => `${s.category || '?'}_${s.direction}`);
const rows = [];
for (const [k, sigs] of Object.entries(groups).sort()) {
  const sumR = sigs.reduce((s, x) => s + effectiveR(x), 0);
  const wins = sigs.filter(s => Number(s.actualRR) > 0).length;
  rows.push({
    grup: k,
    n: sigs.length,
    WR: (100 * wins / sigs.length).toFixed(0) + '%',
    sumR: sumR.toFixed(2),
    avgR: (sumR / sigs.length).toFixed(3),
  });
}
table(rows, [
  { h: 'Grup', k: 'grup' },
  { h: 'n', k: 'n' },
  { h: 'WR', k: 'WR' },
  { h: 'sumR', k: 'sumR' },
  { h: 'avgR', k: 'avgR' },
]);

// --- Hangi sinyaller iptal edildi (özet) ---
console.log('\n=== Senaryo D — iptal edilenler kategori dağılımı ===');
const removed = all.filter(s => SCENARIOS[4].filters.some(f => f(s)));
const removedGroups = byKey(removed, s => `${s.category || '?'}_${s.direction}_${s.regime || '?'}`);
const removedRows = Object.entries(removedGroups)
  .map(([k, sigs]) => {
    const sumR = sigs.reduce((s, x) => s + effectiveR(x), 0);
    return { grup: k, n: sigs.length, sumR: sumR.toFixed(2) };
  })
  .sort((a, b) => Number(a.sumR) - Number(b.sumR));
table(removedRows, [
  { h: 'Grup', k: 'grup' },
  { h: 'n', k: 'n' },
  { h: 'sumR (iptal)', k: 'sumR' },
]);

console.log(`\n=== Sonuç ===`);
const base = results[0];
const best = results.slice(1).sort((a, b) => b.sumR - a.sumR)[0];
console.log(`Baseline: ${base.sumR.toFixed(2)}R (${base.n} sinyal, WR %${base.wr.toFixed(1)})`);
console.log(`En iyi senaryo: ${best.label} → ${best.sumR.toFixed(2)}R (Δ +${(best.sumR - base.sumR).toFixed(2)}R, ${best.removed} sinyal iptal)`);
console.log(`Sinyal başına ortalama iyileşme: ${((best.avgR - base.avgR) * 100).toFixed(1)} bps R`);
