import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDecisionSnapshot,
  decisionSnapshotPathForDate,
  recordDecisionSnapshot,
} from '../lib/learning/decision-snapshot-recorder.js';

// Test izolasyonu: gercek scanner/data/ yolunu kirletmemek icin her testte
// temp dizini kullaniyoruz (baseDir override).
function makeTmpBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decision-snapshot-test-'));
}

test('decision snapshot captures grader input and compact signal output', () => {
  const circular = { symbol: 'UNITTEST' };
  circular.self = circular;

  const snapshot = buildDecisionSnapshot({
    stage: 'per_tf',
    symbol: 'UNITTEST',
    timeframe: '60',
    mode: 'short',
    graderInput: {
      symbol: 'UNITTEST',
      timeframe: '60',
      ohlcv: { bars: [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] },
      circular,
    },
    signal: {
      symbol: 'UNITTEST',
      timeframe: '60',
      grade: 'B',
      direction: 'long',
      entry: 1.234567891,
      sl: 1.1,
      tp1: 1.5,
      tally: { conviction: 6.25, agreement: 80 },
      votes: [{ source: 'ema_cross', direction: 'long', weight: 1.8 }],
      reasoning: ['unit test'],
      unrelatedLargePayload: { ignored: true },
    },
    now: new Date('2099-01-02T03:04:05.000Z'),
  });

  assert.equal(snapshot.schema, 'decision_snapshot');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.stage, 'per_tf');
  assert.equal(snapshot.symbol, 'UNITTEST');
  assert.equal(snapshot.timeframe, '60');
  assert.equal(snapshot.graderInput.circular.self, '[Circular]');
  assert.equal(snapshot.signal.grade, 'B');
  assert.equal(snapshot.signal.entry, 1.23456789);
  assert.equal(snapshot.signal.unrelatedLargePayload, undefined);
});

test('decision snapshot recorder appends JSONL under daily file', () => {
  const baseDir = makeTmpBaseDir();
  try {
    const now = new Date('2099-01-02T03:04:05.000Z');
    const filePath = decisionSnapshotPathForDate(now, { baseDir });

    const snapshot = buildDecisionSnapshot({
      symbol: 'UNITTEST',
      timeframe: '240',
      graderInput: { symbol: 'UNITTEST', timeframe: '240' },
      signal: { grade: 'A', direction: 'short' },
      now,
    });

    const result = recordDecisionSnapshot(snapshot, { now, baseDir });
    assert.equal(result.skipped, false);
    assert.equal(result.filePath, filePath);

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).symbol, 'UNITTEST');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
