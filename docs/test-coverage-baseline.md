# Test Coverage Baseline — Konu 4

**Tarih:** 2026-05-24
**Araç:** Node.js v22 built-in coverage (`node --test --experimental-test-coverage`)
**Komut:** `npm run test:coverage` (scanner/ dizininde)

---

## 1. Neden bu doc?

Patch zinciri sonunda 233 test yeşil ama bu **sayım**, **kapsam** değil. Codex
açık konu listesinde 4. madde olarak flagged etmişti:

> "Mevcut 229 regression test coverage'ı bilinmiyor — IO katmanlarındaki
> (ensureChartReady, gatherRawBundle) kör noktalar formal coverage tool'u
> eklenince görünür hale gelir."

Bu doc baseline'i kayıt altına alıyor; ileride iyileştirme yapılırsa
karşılaştırma noktası.

---

## 2. Özet — genel kapsam

| Metrik | Yüzde |
|---|---|
| Line coverage | **52.06%** |
| Branch coverage | **65.79%** |
| Function coverage | **62.70%** |

Tek satırda: "Yarısı test edilmiş; özellikle branch ve function tarafı zayıf."

---

## 3. Per-file (Patch zinciri kapsamındaki dosyalar)

| Dosya | Line | Branch | Function | Durum |
|---|---|---|---|---|
| `bridge-timeout.js` | 99.38% | 83.33% | 100.00% | ✅ Mükemmel |
| `errors.js` | 100.00% | 91.89% | 100.00% | ✅ Mükemmel |
| `shadow-metrics.js` | 100.00% | 86.67% | 100.00% | ✅ Mükemmel |
| `scanner-engine.js` | **37.17%** | **74.80%** | **48.15%** | ⚠️ Düşük |
| `tv-bridge.js` | 21.18% | 100.00% | 3.23% | ⚠️ Düşük (bridge — beklenen) |
| `signal-grader.js` | 21.74% | 8.06% | 20.00% | ⚠️ Düşük (kapsam dışı) |

**Patch zinciri yeni yazılan modüller** (`bridge-timeout`, `errors`,
`shadow-metrics`) **yüksek kapsama sahip** — bunlar saf veya saf'a yakın,
direkt unit test yazıldı.

**`scanner-engine.js` düşük** çünkü içindeki bridge çağıran fonksiyonlar
unit test edilmedi (Codex'in incremental kuralı: bridge mock'suz test
maliyetli, regression yeterli).

---

## 4. `scanner-engine.js` kör noktaları

Aşağıdaki fonksiyonlar **bridge çağırıyor** ve **unit testi yok**; davranış
garantisi regression test'lerinden geliyor (symbol-guards, lock, bridge-timeout
test suite'leri).

| Satır aralığı | Fonksiyon | Sebep |
|---|---|---|
| 29-31 | Proxy wrapper (bridge timeout) | runtime evaluate; trivial |
| 199-214 | `resolveChartSymbol` | watchlist + inferCategory; kapalı yol |
| 272-276 | `loadRules` cache fallback | hata yolu |
| 432-434, 488-490, 492-495 | Lock state edge cases | drain queue + transferNext detayları |
| **511-567** | **`ensureChartReady`** | **bridge IO; mock'suz test yok** |
| 573-586 | `collectShortTermData` orchestrator | enrichBundle delege |
| **598-677** | **`gatherRawBundle`** | **bridge IO; mock'suz test yok** |
| 817-821, 826-830, 833-835 | `_computeShadowPrimitives` bazı dallar | shadow path edge cases |
| **862-932** | **`collectLongTermData`** | scheduler kullanmıyor (manuel API) |
| **938-993** | **`quickTrendCheck`** | bridge IO; mock'suz test yok |
| **1007-1572** | **`_scanShortTermInner`** | scan orchestrator; bridge çağrı zinciri |
| **1585-1677** | **`_scanLongTermInner`** | long path; manuel kullanım |
| **1700-1773** | **`_batchScanInner`** | scheduler entry; bridge IO |
| 1838-1929 | study extractor helper'ları | studyValues parse |

Kalın yazılanlar **bilinçli kör noktalar** — Codex'in incremental refactor
kuralı gereği bridge mock'lamadan unit test yazılmadı.

---

## 5. Yorum

### 5.1. Düşük yüzde **panik değil**

`scanner-engine.js`'in %37 line coverage'ı düşük görünüyor ama:
- Patch zinciri yeni eklenen kod (Proxy wrapper, ensureChartReady,
  gatherRawBundle, enrichBundle injection) zaten **regression test suite**'i
  ile yeşil — davranış garantisi var.
- Bridge çağıran kod yolları için mock'suz unit test maliyeti yüksek; yatırım
  değerini sağlamıyor.
- Branch coverage (%75) line'dan yüksek — okunmamış satırlar tek dal
  (catch'ler, retry path'leri vs.) → kritik karar mantığı dikkate alınmış.

### 5.2. Function coverage daha anlamlı sinyal

%48 function — yarı yarıya. Test edilmemiş fonksiyonlar:
- `_scanShortTermInner`, `_scanLongTermInner`, `_batchScanInner`,
  `quickTrendCheck`, `ensureChartReady`, `gatherRawBundle`,
  `collectShortTermData`, `collectLongTermData`.
- Tümü bridge IO; aynı sebep.

Saf fonksiyonlar (`enrichBundle`, `assignAssetCategory`,
`assertBareSymbolMatch`, `mergeDeviationRetry`, `loadRules`,
`_resetRulesCache`) **%100 function** kapsamında.

---

## 6. İleride yapılabilecekler

**Şimdi yapmıyoruz**, sadece referans:

### 6.1. Bridge mock framework

`scanner/tests/_helpers/mockBridge.js` modülü:
```js
export function mockBridge({ setSymbolReturns, getOhlcvReturns, ... }) {
  return new Proxy({}, { get: (_, prop) => (...args) => ... });
}
```
ESM module mock zor (Node 22 `mock.module` deneysel). Daha pratik yol:
`scanner-engine.js` bridge'i import yerine **dependency injection** ile alsın
— testlerde fake bridge geçilir. Bu bir refactor (Patch 7+).

### 6.2. c8 + HTML rapor

`npm install --save-dev c8` → `npx c8 npm test` → `coverage/index.html`.
Built-in coverage zero-dep, c8 kullanıcı dostu HTML rapor üretir. Gerekli
oluştuğunda ekle.

### 6.3. CI entegrasyonu

Şu an CI yok. GitHub Actions eklenirse:
```yml
- run: npm run test:coverage
- uses: codecov/codecov-action@v3
  with:
    files: ./scanner/coverage/lcov.info
```
LCOV reporter zaten `npm run test:coverage:lcov` ile aktif.

### 6.4. Threshold

Coverage threshold'u **ŞİMDİ KOYMA**. Önce 2-3 iterasyon doğal artış izle,
sonra realistik bir eşik (örn. line %60, branch %75) belirle. Yapay düşük
eşik motivasyonu kaybettirir; yüksek eşik CI'ı sürekli kırar.

---

## 7. Komutlar

```bash
# scanner/ dizininde
npm run test               # Sade test
npm run test:coverage      # Built-in coverage raporu (spec çıktısı)
npm run test:coverage:lcov # LCOV dosyası (scanner/coverage/lcov.info)
```

LCOV dosyasından HTML üretmek için (opsiyonel):
```bash
brew install lcov
genhtml scanner/coverage/lcov.info -o scanner/coverage/html
open scanner/coverage/html/index.html
```
