/**
 * TV Watchlist Price Feed — TradingView Desktop'tan canli fiyat
 *
 * Yahoo/Google scraping yerine, dogrudan TV Desktop'in watchlist panelindeki
 * row'lari CDP uzerinden okur. Boylece:
 *   - Kullanicinin TV'de gordugu fiyat ile dashboard fiyati birebir esit
 *   - Dis API rate-limit'i yok (HTTP 429 problemi tarihe karisti)
 *   - Pre/post market, BIST, emtia ne goruyorsa TV ne gosteriyorsa o
 *
 * Kosullar:
 *   - TV Desktop CDP port 9222 acik (mevcut tv-bridge.js gibi)
 *   - Watchlist paneli (sag panel) acik olmali; kapali ise feed null doner
 *   - Sadece TV watchlist'inde olan semboller fiyatlanir; rules.json'da olup
 *     watchlist'de olmayanlar fiyatsiz kalir (yanlis veri yerine null)
 */

import { evaluate } from './cdp-connection.js';

const POLL_INTERVAL_MS = 5000;

// tvSymbol (full, ornek: NASDAQ:DXYZ) -> { price, ts }
const _priceMap = new Map();
// bare symbol (DXYZ) -> full symbol — alias lookup icin
const _aliasMap = new Map();

let _timer = null;
let _broadcastFn = null;
let _stopped = false;
let _stats = {
  lastPollAt: null,
  polls: 0,
  errors: 0,
  panelOpen: false,
  symbolsTracked: 0,
  pricesResolved: 0,
  lastError: null,
};

// CDP'de calisacak tarama scripti — sag paneldeki tum watchlist row'lari oku.
const READ_JS = `
(function() {
  try {
    var area = document.querySelector('[class*="layout__area--right"]');
    if (!area || area.offsetWidth < 50) return { ok: false, reason: 'panel_closed', rows: [] };

    var rows = [];
    var seen = {};
    var symEls = area.querySelectorAll('[data-symbol-full]');
    for (var i = 0; i < symEls.length; i++) {
      var sym = symEls[i].getAttribute('data-symbol-full');
      if (!sym || seen[sym]) continue;
      seen[sym] = true;
      var row = symEls[i].closest('[class*="row"]') || symEls[i].parentElement;
      if (!row) continue;

      // Tum hucreleri tara, ilk gecerli (yuzde olmayan, pozitif) decimal'i fiyat say.
      var cells = row.querySelectorAll('[class*="cell"], [class*="column"]');
      var price = null;
      for (var j = 0; j < cells.length; j++) {
        var raw = (cells[j].textContent || '').trim();
        if (!raw || raw.indexOf('%') >= 0) continue;
        // TV bazen virgullu yaziyor (54,60), bazen noktayla (54.60); ikisini de destekle.
        var s = raw.replace(/[\\s\\u202f\\u00a0]/g, '');
        // Virgul varsa ve nokta yoksa decimal separator olarak yorumla
        if (s.indexOf(',') >= 0 && s.indexOf('.') < 0) s = s.replace(/,/g, '.');
        else s = s.replace(/,/g, ''); // bin ayraci
        if (!/^[+-]?\\d+\\.?\\d*$/.test(s)) continue;
        var n = parseFloat(s);
        if (isFinite(n) && n > 0) { price = n; break; }
      }
      rows.push({ symbol: sym, price: price });
    }
    return { ok: true, rows: rows };
  } catch (e) {
    return { ok: false, reason: 'error: ' + (e && e.message ? e.message : 'unknown'), rows: [] };
  }
})()
`;

async function pollOnce() {
  _stats.polls++;
  _stats.lastPollAt = Date.now();

  let data;
  try {
    data = await evaluate(READ_JS);
  } catch (e) {
    _stats.errors++;
    _stats.lastError = e.message || String(e);
    _stats.panelOpen = false;
    return;
  }

  if (!data || !data.ok) {
    _stats.errors++;
    _stats.lastError = data?.reason || 'unknown';
    _stats.panelOpen = false;
    return;
  }
  _stats.panelOpen = true;
  _stats.lastError = null;

  const updates = [];
  let resolved = 0;
  const ts = Date.now();
  for (const r of data.rows) {
    if (!r.symbol) continue;
    // Bare alias kaydet (NASDAQ:DXYZ -> DXYZ)
    if (r.symbol.includes(':')) {
      const bare = r.symbol.split(':')[1];
      if (bare) _aliasMap.set(bare, r.symbol);
    }
    if (r.price == null) continue;
    resolved++;
    const prev = _priceMap.get(r.symbol);
    _priceMap.set(r.symbol, { price: r.price, ts });
    if (prev && prev.price === r.price) continue;
    updates.push({ tvSymbol: r.symbol, price: r.price, ts, marketState: 'REGULAR' });
  }
  _stats.symbolsTracked = data.rows.length;
  _stats.pricesResolved = resolved;

  if (updates.length > 0 && _broadcastFn) {
    _broadcastFn({ type: 'live_prices', updates });
  }
}

export function getTVPrice(tvSymbol) {
  if (!tvSymbol) return null;
  const direct = _priceMap.get(tvSymbol);
  if (direct) return direct.price;
  // Bare sembol verildi (DXYZ); alias map'ten full sembolu cozumle
  const full = _aliasMap.get(tvSymbol);
  if (full) {
    const e = _priceMap.get(full);
    if (e) return e.price;
  }
  // Son care: prefix'li girildi ama farkli prefix kaydedildi
  if (tvSymbol.includes(':')) {
    const bare = tvSymbol.split(':')[1];
    const full2 = _aliasMap.get(bare);
    if (full2) {
      const e = _priceMap.get(full2);
      if (e) return e.price;
    }
  }
  return null;
}

export function getAllTVPrices() {
  const out = {};
  for (const [tvSymbol, entry] of _priceMap.entries()) {
    out[tvSymbol] = { price: entry.price, ts: entry.ts, source: 'tv_watchlist', marketState: 'REGULAR' };
    if (tvSymbol.includes(':')) {
      const bare = tvSymbol.split(':')[1];
      if (bare && !out[bare]) {
        out[bare] = { price: entry.price, ts: entry.ts, source: 'tv_watchlist', marketState: 'REGULAR' };
      }
    }
  }
  return out;
}

export function getTVFeedStats() {
  return { ..._stats };
}

export function startTVWatchlistFeed(options = {}) {
  _broadcastFn = options.broadcast || null;
  if (_timer) {
    console.log('[TVFeed] Zaten calisiyor — yeni timer baslatilmadi');
    return;
  }
  _stopped = false;
  pollOnce().catch(e => console.log('[TVFeed] ilk poll hatasi:', e.message));
  _timer = setInterval(() => {
    if (_stopped) return;
    pollOnce().catch(e => console.log('[TVFeed] poll hatasi:', e.message));
  }, POLL_INTERVAL_MS);
  console.log(`[TVFeed] Baslatildi — ${POLL_INTERVAL_MS / 1000}sn aralikla TV watchlist polling`);
}

export function stopTVWatchlistFeed() {
  _stopped = true;
  if (_timer) { clearInterval(_timer); _timer = null; }
}
