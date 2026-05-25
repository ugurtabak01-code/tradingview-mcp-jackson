/**
 * Decision Snapshot Recorder
 *
 * Append-only capture of the exact grader input and output seen by the live
 * scanner. These records are for future replay/backtest parity and must not
 * influence live signal decisions.
 */

import fs from 'fs';
import path from 'path';
import { dataPath } from './persistence.js';

export const DECISION_SNAPSHOT_VERSION = 1;

const SNAPSHOT_DIR = dataPath('signals', 'decision-snapshots');
const MAX_STRING_LENGTH = 2000;

function isoDate(value) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

export function decisionSnapshotPathForDate(value = new Date(), { baseDir = SNAPSHOT_DIR } = {}) {
  return path.join(baseDir, `${isoDate(value)}.jsonl`);
}

function roundNumber(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1e8) / 1e8;
}

function safeClone(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (typeof val === 'number') return roundNumber(val);
    if (typeof val === 'string' && val.length > MAX_STRING_LENGTH) {
      return `${val.slice(0, MAX_STRING_LENGTH)}...[truncated:${val.length}]`;
    }
    if (typeof val === 'function' || typeof val === 'symbol' || typeof val === 'undefined') return null;
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  }));
}

function compactSignal(signal) {
  if (!signal || typeof signal !== 'object') return signal || null;
  return safeClone({
    symbol: signal.symbol || null,
    timeframe: signal.timeframe || signal.tf || null,
    grade: signal.grade || null,
    direction: signal.direction || null,
    position_pct: signal.position_pct ?? null,
    entry: signal.entry ?? null,
    sl: signal.sl ?? null,
    tp1: signal.tp1 ?? null,
    tp2: signal.tp2 ?? null,
    tp3: signal.tp3 ?? null,
    rr: signal.rr ?? null,
    entrySource: signal.entrySource || null,
    smartEntryDiagnostics: signal.smartEntryDiagnostics || null,
    slSource: signal.slSource || null,
    regime: signal.regime || null,
    tally: signal.tally || null,
    votes: Array.isArray(signal.votes) ? signal.votes : null,
    reasoning: Array.isArray(signal.reasoning) ? signal.reasoning : [],
    warnings: Array.isArray(signal.warnings) ? signal.warnings : [],
    shadowMetrics: signal.shadowMetrics || null,
    shadowVotes: Array.isArray(signal.shadowVotes) ? signal.shadowVotes : null,
    shadowFeatures: signal.shadowFeatures || null,
    htfConfidence: signal.htfConfidence ?? null,
    mtfAlignment: signal.mtfAlignment ?? null,
  });
}

export function buildDecisionSnapshot({
  stage = 'per_tf',
  symbol,
  timeframe,
  mode = 'short',
  graderInput,
  signal,
  context = {},
  now = new Date(),
}) {
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return safeClone({
    schema: 'decision_snapshot',
    version: DECISION_SNAPSHOT_VERSION,
    stage,
    createdAt,
    symbol: symbol || graderInput?.symbol || signal?.symbol || null,
    timeframe: String(timeframe ?? graderInput?.timeframe ?? signal?.timeframe ?? signal?.tf ?? ''),
    mode,
    graderInput,
    signal: compactSignal(signal),
    context,
  });
}

// baseDir test izolasyonu icin enjekte edilebilir; production cagrilari default
// SNAPSHOT_DIR kullanir (geriye uyumlu).
export function recordDecisionSnapshot(snapshot, { now = new Date(), baseDir = SNAPSHOT_DIR } = {}) {
  if (process.env.DECISION_SNAPSHOT_ENABLED === '0') return { skipped: true, reason: 'disabled' };
  if (!snapshot || typeof snapshot !== 'object') return { skipped: true, reason: 'empty_snapshot' };

  const filePath = decisionSnapshotPathForDate(now, { baseDir });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(snapshot)}\n`, 'utf-8');
  return { skipped: false, filePath };
}
