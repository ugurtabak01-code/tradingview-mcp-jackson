/**
 * HTML render helper for the fundamental snapshot block.
 * Pure string output — caller (dashboard) decides where to inject.
 */

import { STANCE_LABELS } from './constants.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderFundamentalSnapshotHtml(snapshot) {
  if (!snapshot) return '';
  const overall = STANCE_LABELS[snapshot.overall] || STANCE_LABELS.unknown;
  const rows = (snapshot.sections || []).map(s => `
    <div class="fundamental-row" data-stance="${escape(s.stance)}">
      <span class="f-label">${escape(s.label)}</span>
      <strong class="f-stance">${escape(STANCE_LABELS[s.stance] || STANCE_LABELS.unknown)}</strong>
      <small class="f-summary">${escape(s.summary || '')}</small>
    </div>
  `).join('');

  const meta = [];
  if (snapshot.asOf) meta.push(`asOf: ${escape(snapshot.asOf.slice(0, 10))}`);
  if (snapshot.fiscalPeriod) meta.push(`donem: ${escape(snapshot.fiscalPeriod)}`);
  if (snapshot.freshness) meta.push(`tazelik: ${escape(snapshot.freshness)}`);

  return `
    <section class="fundamental-section" data-overall="${escape(snapshot.overall)}">
      <h4>Temel Analiz — ${escape(overall)}</h4>
      ${meta.length ? `<div class="fundamental-meta">${meta.join(' · ')}</div>` : ''}
      ${rows}
    </section>
  `;
}
