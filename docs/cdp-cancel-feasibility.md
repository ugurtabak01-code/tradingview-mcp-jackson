# CDP Cancel Feasibility — Patch 3a Araştırma Notu

**Tarih:** 2026-05-23
**Amaç:** Patch 2 (bridge timeout) sonrası asılı kalan CDP request'lerinin
gerçekten iptal edilip edilemeyeceğini netleştirmek; Patch 3b (scan-seviye
abort/timeout) tasarımına temel oluşturmak.

---

## 1. Mevcut altyapı

- **Bağımlılık:** [`chrome-remote-interface`](https://www.npmjs.com/package/chrome-remote-interface) (npm).
- **Bağlantı modeli:** Singleton `client` (`scanner/lib/cdp-connection.js`).
  Browser-level WebSocket → `Target.getTargets` → chart target → page-level
  WebSocket → `Runtime.enable` / `Page.enable` / `DOM.enable`.
- **JS injection:** `client.Runtime.evaluate({ expression, returnByValue, awaitPromise, ... })`.
- **Promise davranışı:** WebSocket round-trip; Chrome/Electron `Runtime.evaluate`
  yanıtı dönene kadar Promise pending kalır.

---

## 2. Soru: CDP gerçek bir "cancel" mekanizması sağlıyor mu?

**Kısa cevap: HAYIR.** Bizim use-case (Runtime.evaluate ile JS injection)
için CDP üzerinden inflight bir request'i iptal etmenin temiz bir yolu yok.

### 2.1. İncelenen seçenekler

| Seçenek | Davranış | Use-case'imize uygun mu? |
|---|---|---|
| `client.close()` / WebSocket disconnect | Local Promise'i `Error: WebSocket connection closed` ile reject eder. **Ama Chrome/Electron tarafındaki JS execution devam eder** — server'a "iptal" sinyali gönderilmez. | Yarı çare. Local temizlik var; yan etki devam eder. |
| `Runtime.terminateExecution` | Execution context'in TÜM JS'ini terminate eder (sayfanın). Chart widget state'i bozulur. | Hayır — bizim eval'imizi değil, sayfanın tümünü öldürür. Üretim akışında kullanılamaz. |
| `Page.close` / `Target.closeTarget` | Sayfayı/target'ı tamamen kapatır. | Hayır — TradingView kullanıcı arayüzünü kapatır. |
| `Network.continueInterceptedRequest` / `Fetch.failRequest` | HTTP request'leri kapsar (network layer). | Hayır — Runtime.evaluate JS execution layer; alakasız. |
| Tek bir `evaluate` çağrısına requestId düzeyinde iptal | CDP protokolünde böyle bir metod yok. | Hayır — protokol seviyesinde imkansız. |

### 2.2. WebSocket close — daha detaylı

`chrome-remote-interface` kütüphanesi WebSocket close edildiğinde inflight
`evaluate` Promise'lerini reject eder (`Error: WebSocket connection closed`).
**Ancak:**
- Chrome/Electron Runtime altında çalışan JS execution context **canlı kalır**.
- Asılı setSymbol/setTimeframe gibi side-effecting çağrılar yan etkilerini
  arka planda tamamlar.
- Yeni bir WebSocket bağlantısı açıldığında, eski "asılı" JS'lerin yarattığı
  chart state üzerine geliriz.

---

## 3. Bizim için ne anlama geliyor?

### 3.1. Patch 2'nin `Promise.race` zaten optimal

`withCdpTimeout(promise, op)` local Promise'i timer ile yarıştırıyor; timeout
fire ettiğinde **lokal olarak vazgeçiyor**. Bu davranış CDP'nin sunduğu en
agresif "iptal"den daha azını yapmıyor: chrome-remote-interface
`client.close()` de aynı semantiği veriyor (lokal reject, server-side devam).

→ **Patch 2 yeterli savunma; Patch 3b'de AbortSignal eklemek window dressing.**

### 3.2. Side-effect race window — Patch 1'in kritikliği

Patch 2 timeout sonrası en büyük risk:
- Tarama A `setSymbol(BTCUSDT)` gönderir → 30s timeout fire eder → A HATA olur.
- 5s sonra TradingView chart gerçekten BTCUSDT'ye geçer (asılı JS tamamlandı).
- Bu arada Tarama B `setSymbol(ETHUSDC)` başlamış olabilir → kontaminasyon!

**Patch 1'in `assertBareSymbolMatch` guard'ları bu race'i yakalar:**
- B'nin pre-check: chart'ta BTCUSDT görür, ETHUSDC değil → fail-closed → abort.
- B HATA grade'iyle düşer; **veri kontamine olmaz.**

→ **Patch 1 + Patch 2 birlikte yeterli; sessiz kontaminasyon yerine loud HATA.**

### 3.3. Asılı JS'i temizlemenin tek pratik yolu: reconnect

CDP üstünden iptal yok, ama `disconnect()` + `connect()` yapıldığında:
- Eski client'ın inflight Promise'leri zaten reject edilmiş.
- Yeni client yeni WebSocket üstünden gelir; eski "asılı" JS'leri görmez.
- Bir sonraki tarama temiz state'le başlar (asılı setSymbol'ün etkisi
  Patch 1 guard'larıyla yakalanır).

**Maliyet:** reconnect ~1-3s sürer (findChartTargetViaBrowserWS +
Runtime/Page/DOM.enable). Scheduler ritminde fark edilir.

---

## 4. Tavsiye — Patch 3b'nin kapsamı

**Patch 3b'yi AbortSignal ile değil, iki katmanlı emniyet ağı olarak tasarla:**

### 4.1. Katman 1 — Consecutive timeout sayacı + reconnect

```
let _consecutiveTimeouts = 0;
const RECONNECT_THRESHOLD = 3;

withCdpTimeout(...).catch(err => {
  if (isCdpTimeoutError(err)) {
    _consecutiveTimeouts++;
    if (_consecutiveTimeouts >= RECONNECT_THRESHOLD) {
      console.warn('[CDP] 3 ardisik timeout — reconnect tetikleniyor');
      disconnect().then(() => connect());
      _consecutiveTimeouts = 0;
    }
  }
  throw err;
});

// Başarılı her CDP call'da sayacı sıfırla
withCdpTimeout(...).then(result => {
  _consecutiveTimeouts = 0;
  return result;
});
```

**N=3 gerekçesi:** Tek timeout muhtemelen ağ hıçkırığı veya geçici slow query.
Ardışık 3 = gerçek hung. Bu eşik altında reconnect maliyetini ödemiyoruz.

### 4.2. Katman 2 — Top-level scan timeout (son emniyet ağı)

```
scanShortTerm/scanLongTerm/batchScan içinde:
  await acquireScanLock(holder, MAX_SCAN_LOCK_WAIT_MS = 600000); // 10 dk
```

Hiçbir taramanın 10 dakikadan fazla lock tutamadığını garantiler. Bu, alttaki
katmanlar başarısız olsa bile scheduler'ın takılmamasını sağlar. Mevcut
`acquireScanLock(holder, timeoutMs)` zaten destekliyor (Patch 1.5'te
test edildi).

### 4.3. Hariç tutulanlar

- ❌ **AbortSignal entegrasyonu** — CDP'de karşılığı yok, sadece local
  Promise reject demek (Patch 2 ile aynı). Yeni kod ekler, yeni davranış
  getirmez.
- ❌ **Runtime.terminateExecution kullanımı** — chart bozar, recovery
  zor. Belki gelecekte "manuel kill switch" tool'u olarak (kullanıcı
  açık komutla tetikler), ama scheduler içinde otomatik değil.

---

## 5. Açık sorular / gelecek riskler

1. **TradingView Desktop'ta `Page.reload` davranışı** — Electron container
   içinde sayfa reload'u, JS state'i (login session, chart layout) kaybeder
   mi? Reconnect sonrası kullanıcı tekrar login mi olur?
   → Test edilmeli (manuel; günde 1 kez tetiklenecek bir kod yolu).

2. **Asılı setSymbol'ün uzun vadeli etkisi** — eğer ardışık 3 tarama da
   asılı setSymbol bırakırsa, chart 3 sembol arasında "stack" yapabilir
   mi? CDP `Runtime.evaluate` ile gönderilen JS'in execution sırası
   garantili mi?
   → Doğru cevap: CDP request'leri FIFO; ama JS içindeki async await'ler
   sıra dışı tamamlanabilir. setSymbol bizim kodumuzda await'siz fire-and-forget
   değil, await edilen bir call — asılı kalırsa scanner ilerleyemez (mevcut
   davranış). Sonraki setSymbol queue'ya girer mi yoksa yeni evaluate
   olarak mı gider? **chrome-remote-interface paralel evaluate'ler izin
   verir; çakışma chart-mutex katmanında çözülür.**

3. **Reconnect sırasında chart-mutex** — disconnect()/connect() chart-mutex
   tutarken yapılırsa, sonraki acquire başarısız mı olur? Reconnect logic'i
   mutex DIŞINDA yapılmalı.
   → Patch 3b implementation'ında bu kritik: reconnect tetikleyici
   `withCdpTimeout`'un `.catch` zincirinde değil, scan'in finally bloğunda
   olmalı.

---

## 6. Karar

- **Patch 3a (bu doc) tamam.** CDP cancel = yok; AbortSignal = window dressing.
- **Patch 3b implementation kapsamı:**
  - (1) Consecutive timeout sayacı + reconnect (N=3).
  - (2) Top-level scan lock timeout (10 dk, env var ile override).
  - (3) Reconnect tetikleyici mutex'i tutmaz; scan finally bloğunda çalışır.
- **AbortSignal eklenmeyecek** — gerekçeler bu doc'ta kaydedildi, gelecekte
  tekrar gündeme gelirse referans.
