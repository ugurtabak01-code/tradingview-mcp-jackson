/**
 * Wrapper Mode — dispatch kontrol bayrağı.
 *
 * Shadow mode canlı sistemde geçerli değildir. Varsayılan mod live'dır.
 * Geçiş güvenliği için ilk 5 gün real lig sinyalleri executor'a ara lig
 * gibi gönderilir; böylece executor tarafında onaya düşer.
 *
 * Persist: scanner/data/wrapper-mode.json (restart-safe)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '..', '..', 'data', 'wrapper-mode.json');

const VALID_MODES = ['live', 'disabled'];
const REAL_LEAGUE_APPROVAL_DAYS = 5;

function approvalUntilFrom(now = new Date()) {
  return new Date(now.getTime() + REAL_LEAGUE_APPROVAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function defaultState() {
  return {
    mode: 'live',
    since: new Date().toISOString(),
    realLeagueApprovalOnlyUntil: approvalUntilFrom(),
    history: [],
  };
}

function normalizeState(raw) {
  const now = new Date().toISOString();
  if (!raw || typeof raw !== 'object') return defaultState();
  if (!VALID_MODES.includes(raw.mode)) {
    const next = {
      mode: 'live',
      since: now,
      realLeagueApprovalOnlyUntil: raw.realLeagueApprovalOnlyUntil || approvalUntilFrom(new Date(now)),
      history: [...(raw.history || []), {
        from: raw.mode || null,
        to: 'live',
        at: now,
        by: 'wrapper-mode-migration',
        reason: 'shadow mode removed',
      }].slice(-100),
    };
    writeState(next);
    return next;
  }
  if (!raw.realLeagueApprovalOnlyUntil) {
    const next = {
      ...raw,
      realLeagueApprovalOnlyUntil: approvalUntilFrom(new Date(raw.since || now)),
    };
    writeState(next);
    return next;
  }
  return raw;
}

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      const s = defaultState();
      writeState(s);
      return s;
    }
    return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch (err) {
    console.error('[wrapper-mode] read failed, defaulting to live:', err.message);
    return defaultState();
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[wrapper-mode] write failed:', err.message);
  }
}

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 1000;

export function getWrapperMode() {
  if (!_cache || Date.now() - _cacheAt > CACHE_TTL_MS) {
    _cache = readState();
    _cacheAt = Date.now();
  }
  return _cache;
}

export function isLive() { return getWrapperMode().mode === 'live'; }
export function isShadow() { return false; }
export function isDisabled() { return getWrapperMode().mode === 'disabled'; }

export function isRealLeagueApprovalOnly({ now = new Date() } = {}) {
  const state = getWrapperMode();
  const until = Date.parse(state.realLeagueApprovalOnlyUntil || '');
  return state.mode === 'live' && Number.isFinite(until) && now.getTime() < until;
}

export function routeLeagueForExecutor(league, { now = new Date() } = {}) {
  const originalLeague = league || null;
  const approvalOnlyActive = originalLeague === 'real' && isRealLeagueApprovalOnly({ now });
  return {
    league: approvalOnlyActive ? 'ara' : originalLeague,
    originalLeague,
    approvalOnlyActive,
    approvalOnlyUntil: getWrapperMode().realLeagueApprovalOnlyUntil || null,
  };
}

/**
 * @param {{mode:'live'|'disabled', by:string, reason?:string, realLeagueApprovalOnlyUntil?:string|null}} opts
 */
export function setWrapperMode({ mode, by, reason = '', realLeagueApprovalOnlyUntil = undefined }) {
  if (!VALID_MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
  const current = readState();
  const now = new Date().toISOString();

  // 2026-05-25 (Codex bug fix P1): operator API'den approval-only window'u
  // KISALTAMAZ. Sadece UZATILABILIR. Kabul kurallari:
  //   - undefined  → mevcut deger korunur, yoksa default 5 gunluk window
  //   - null       → reddedilir, mevcut korunur
  //   - gecmis     → reddedilir
  //   - >= max(current, default_min)  → kabul (uzatma)
  //   - <  max(current, default_min)  → reddedilir (kisaltma yasak)
  //
  // default_min = approvalUntilFrom(now) yani su andan itibaren 5 gun. Boylece
  // ilk kurulumda dahi 5 gun altina inilemez; sonradan da current'tan asagi
  // cekilemez.
  const defaultMin = approvalUntilFrom(new Date(now));
  const minRequired = current.realLeagueApprovalOnlyUntil
    && new Date(current.realLeagueApprovalOnlyUntil).getTime() > new Date(defaultMin).getTime()
      ? current.realLeagueApprovalOnlyUntil
      : defaultMin;

  let nextApprovalUntil;
  if (realLeagueApprovalOnlyUntil === undefined) {
    nextApprovalUntil = current.realLeagueApprovalOnlyUntil || defaultMin;
  } else {
    const candidate = realLeagueApprovalOnlyUntil ? new Date(realLeagueApprovalOnlyUntil) : null;
    const candidateMs = candidate && !isNaN(candidate.getTime()) ? candidate.getTime() : null;
    const minMs = new Date(minRequired).getTime();
    if (candidateMs !== null && candidateMs >= minMs) {
      // Uzatma kabul.
      nextApprovalUntil = realLeagueApprovalOnlyUntil;
    } else {
      // Kisaltma, gecmis veya null reddedilir; mevcut/min korunur.
      nextApprovalUntil = minRequired;
      console.warn(`[wrapper-mode] realLeagueApprovalOnlyUntil=${realLeagueApprovalOnlyUntil} reddedildi (kisaltma yasak; min=${minRequired})`);
    }
  }

  const next = {
    mode,
    since: now,
    realLeagueApprovalOnlyUntil: nextApprovalUntil,
    history: [...(current.history || []), {
      from: current.mode, to: mode, at: now, by, reason,
    }].slice(-100),
  };
  writeState(next);
  _cache = next;
  _cacheAt = Date.now();
  console.warn(`[wrapper-mode] ${current.mode} → ${mode} by ${by}: ${reason}`);
  return next;
}

export function _resetWrapperMode() {
  try { fs.unlinkSync(STATE_PATH); } catch {}
  _cache = null;
}

export const __internals = { STATE_PATH, VALID_MODES, REAL_LEAGUE_APPROVAL_DAYS };
