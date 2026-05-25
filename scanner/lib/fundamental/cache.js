/**
 * Local fundamentals cache — read/write JSON files per symbol.
 * Scanner runtime is read-only; sync scripts write.
 */

import fs from 'fs';
import path from 'path';
import { dataPath } from '../learning/persistence.js';

const US_EQUITY_DIR = dataPath('fundamentals', 'us-equity');

function bareSymbol(symbol) {
  const s = String(symbol || '');
  const noPrefix = s.includes(':') ? s.split(':')[1] : s;
  return noPrefix.toUpperCase().trim();
}

export function usEquityCachePath(symbol) {
  return path.join(US_EQUITY_DIR, `${bareSymbol(symbol)}.json`);
}

export function readUsEquityFundamentalCache(symbol) {
  const file = usEquityCachePath(symbol);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeUsEquityFundamentalCache(symbol, payload) {
  fs.mkdirSync(US_EQUITY_DIR, { recursive: true });
  const file = usEquityCachePath(symbol);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

export function listCachedUsEquitySymbols() {
  if (!fs.existsSync(US_EQUITY_DIR)) return [];
  return fs.readdirSync(US_EQUITY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}
