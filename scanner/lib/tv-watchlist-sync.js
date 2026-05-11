/**
 * TV Watchlist Sync — rules.json'daki sembolleri TV Desktop watchlist'ine ekler.
 *
 * Onemli: TV watchlist panelinin "Add symbol" butonu chart'i degistirmeden
 * watchlist'e ekler. Bu yuzden bu islem chart lock altinda yapilir, yapilmadiginda
 * scanner ile cakisabilir.
 *
 * Tetikleme:
 *   - Boot sonrasi tek seferlik (server.js icinden)
 *   - POST /api/tv-watchlist/sync (manuel)
 *
 * Kosullar:
 *   - TV Desktop CDP acik
 *   - Chart lock alinabiliyor olmali (scan aktif degilse hemen, aksi halde kuyrukta)
 *
 * Guvenlik:
 *   - Tek bootta en fazla MAX_ADDS_PER_RUN sembol eklenir (uzun batch'leri dilimle)
 *   - Her ekleme arasi ADD_DELAY_MS bekleme
 *   - Eklenecek listeden once mevcut TV watchlist'i okunup diff alinir
 *   - Kripto sembolleri atlanir (Binance WS push feed onlari zaten besliyor)
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { evaluate, getClient } from './cdp-connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '..', '..', 'rules.json');

const MAX_ADDS_PER_RUN = 30;
const ADD_DELAY_MS = 900;
const NON_CRYPTO_CATEGORIES = ['abd_hisse', 'emtia', 'bist', 'forex'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readRulesWatchlist() {
  try {
    const raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
    const w = raw.watchlist || {};
    const out = [];
    for (const cat of NON_CRYPTO_CATEGORIES) {
      for (const s of (w[cat] || [])) out.push(s);
    }
    return out;
  } catch (e) {
    console.log('[TVSync] rules.json okunamadi:', e.message);
    return [];
  }
}

async function readCurrentTVWatchlist() {
  const data = await evaluate(`
    (function() {
      var area = document.querySelector('[class*="layout__area--right"]');
      if (!area || area.offsetWidth < 50) return { ok: false, reason: 'panel_closed', symbols: [] };
      var seen = {}; var out = [];
      var els = area.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < els.length; i++) {
        var full = els[i].getAttribute('data-symbol-full');
        if (!full || seen[full]) continue;
        seen[full] = true;
        out.push(full);
      }
      return { ok: true, symbols: out };
    })()
  `);
  return data || { ok: false, symbols: [] };
}

async function ensureWatchlistPanelOpen() {
  const state = await evaluate(`
    (function() {
      var area = document.querySelector('[class*="layout__area--right"]');
      if (area && area.offsetWidth >= 50) return { open: true };
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { open: false, error: 'watchlist_button_not_found' };
      btn.click();
      return { open: true, opened: true };
    })()
  `);
  if (state?.opened) await sleep(700);
  return state?.open === true;
}

async function clickAddSymbolButton() {
  const r = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { ok: true, sel: selectors[s] }; }
      }
      return { ok: false };
    })()
  `);
  return !!r?.ok;
}

async function typeAndConfirm(symbol) {
  const c = await getClient();
  await c.Input.insertText({ text: symbol });
  await sleep(450);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await sleep(250);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
}

function bareSymbol(s) {
  return (s || '').includes(':') ? s.split(':')[1] : s;
}

/**
 * rules.json non-crypto sembollerini TV watchlist'ine senkronize et.
 * Mevcut sembolleri tekrar eklemez. Bir bootta en fazla MAX_ADDS_PER_RUN ekler.
 */
export async function syncRulesToTVWatchlist({ maxAdds = MAX_ADDS_PER_RUN } = {}) {
  const wanted = readRulesWatchlist();
  if (wanted.length === 0) return { ok: true, added: [], skipped: 0, reason: 'rules_empty' };

  // Once panel acik mi kontrol et
  const panelOpen = await ensureWatchlistPanelOpen();
  if (!panelOpen) return { ok: false, added: [], reason: 'panel_unavailable' };

  const cur = await readCurrentTVWatchlist();
  if (!cur.ok) return { ok: false, added: [], reason: cur.reason || 'read_failed' };

  // Mevcut watchlist'tekileri bare ve full forma normalize et
  const have = new Set();
  for (const s of cur.symbols) {
    have.add(s);
    have.add(bareSymbol(s));
  }

  const missing = [];
  for (const s of wanted) {
    const bare = bareSymbol(s);
    if (have.has(s) || have.has(bare)) continue;
    missing.push(s);
  }

  if (missing.length === 0) {
    return { ok: true, added: [], skipped: 0, alreadyHas: wanted.length };
  }

  // Chart lock GEREKMIYOR: "+" butonu watchlist paneline yazi yaziyor, chart'i degistirmiyor.
  // Scanner CHART_API.setSymbol kullanir, klavye degil — cakisma riski yok.
  const toAdd = missing.slice(0, maxAdds);
  console.log(`[TVSync] ${toAdd.length}/${missing.length} eksik sembol eklenecek (toplam istek: ${wanted.length})`);

  const added = [];
  const failed = [];
  for (const sym of toAdd) {
    const opened = await clickAddSymbolButton();
    if (!opened) { failed.push({ sym, reason: 'add_btn_not_found' }); break; }
    await sleep(250);
    try {
      await typeAndConfirm(sym);
      added.push(sym);
    } catch (e) {
      failed.push({ sym, reason: e.message });
    }
    await sleep(ADD_DELAY_MS);
  }

  console.log(`[TVSync] eklendi: ${added.length}, basarisiz: ${failed.length}, kalan: ${Math.max(0, missing.length - toAdd.length)}`);
  return {
    ok: true,
    added,
    failed,
    remainingNotAdded: Math.max(0, missing.length - toAdd.length),
    totalWanted: wanted.length,
  };
}
