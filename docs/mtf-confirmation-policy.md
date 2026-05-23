# Multi-Timeframe (MTF) Confirmation Policy

**Tarih:** 2026-05-23
**Durum:** YÜRÜRLÜKTE
**Sahibi:** scanner ana karar zinciri

---

## 1. Karar

**MTF confirmation (`mtfConfirmation`) sert kapı (hard veto) DEĞİLDİR. Advisory'dir.**

Birden fazla zaman dilimi (TF) bir taramada grade'lenip yön farklı çıktığında
(`mixed` veya `opposed`), sinyalin grade'i **düşürülmez** ve **iptal edilmez**.
Yalnızca `bestSignal.reasoning` listesine açıklayıcı bir satır eklenir.

---

## 2. Gerekçeler

### 2.1. Ürün kararı

Kullanıcı (proje sahibi) 2026-05-23 oturumunda açıkça belirtti:

> "mtfConfirmation'ı HTF gate gibi sert kapı yapmayacağız."

### 2.2. Teknik gerekçe

- **HTF gate** zaten ayrı bir savunma katmanı olarak çalışıyor (4H sinyal için
  1D teyidi, 1D sinyal için 1W teyidi). Bkz. [scanner-engine.js](../scanner/lib/scanner-engine.js)
  içinde `confirmTFsForExec` ve "HTF Gate" bölümü.
- MTF (4H + 1D'in birbiriyle uyumu) **aynı sembolde aynı yönde sinyal varlığı**
  ile ilgili; HTF gate gibi "üst TF trend yönü" değil. Bu iki kavram örtüşür
  ama özdeş değildir.
- 4H sinyal ile 1D sinyalinin yön farkı (MTF mixed/opposed) bir "uyumsuzluk"
  değil, **iki bağımsız fırsatın çakışması** olabilir. Sert veto bilgi kaybı
  yaratır.
- Mevcut HTF Gate + Liga + R:R + sanity filtreleri uyumsuzluk durumlarını
  zaten yeterince eliyor; MTF üstüne ekstra hard veto **redundant ve aşırı
  conservative** olur.

### 2.3. Davranışsal yan etki

- Hard MTF veto eklenseydi: çakışmayan iki bağımsız fırsat (ör. 4H short setup
  + 1D long trend reversal sinyali) ikisi de bastırılırdı.
- Advisory tutmak: kullanıcı `reasoning` satırını okuyarak bilinçli karar
  verebilir; otomatik sistem (executor) yine grade'e göre işlem yapar.

---

## 3. Mevcut implementation

### 3.1. Hesaplama

`mtfConfirmation` hesabı [scanner-engine.js — `_scanShortTermInner`](../scanner/lib/scanner-engine.js)
içinde, tüm execution TF'leri grade'lendikten sonra:

```js
// Multi-TF confirmation: count how many TFs agree on direction
const validSignals = tfSignals.filter(s => s.grade && ![IPTAL,HATA,BEKLE].includes(s.grade));

if (validSignals.length > 1) {
  const longCount = validSignals.filter(s => s.direction === 'long').length;
  const shortCount = validSignals.filter(s => s.direction === 'short').length;
  const total = validSignals.length;

  if (longCount >= total * 0.75) {
    mtfConfirmation = { direction: 'long', agreement: ..., count, total };
  } else if (shortCount >= total * 0.75) {
    mtfConfirmation = { direction: 'short', agreement: ..., count, total };
  } else {
    mtfConfirmation = { direction: 'mixed', ..., count, total };
  }
}
```

**Eşik: %75 same-direction.** %75 altı → `mixed`.

### 3.2. Uygulama (sadece reasoning satırı)

```js
if (mtfConfirmation && bestSignal.grade && !['IPTAL','HATA'].includes(bestSignal.grade)) {
  bestSignal.reasoning ||= [];
  if (mtfConfirmation.direction === 'mixed') {
    bestSignal.reasoning.push(`MTF uyumu %75 altinda (${count}/${total}) — advisory (grade korundu)`);
  } else if (mtfConfirmation.direction !== bestSignal.direction) {
    bestSignal.reasoning.push(`MTF ${MTF_DIR} celiskili (sinyal ${SIG_DIR}) — advisory (grade korundu)`);
  } else {
    bestSignal.reasoning.push(`Multi-TF dogrulama: ${count}/${total} TF ${DIR} yonunde (%${agreement} uyum)`);
  }
}
```

**Grade'e dokunulmaz.** `bestSignal.grade` aynı kalır; `reasoning` tek satır
açıklayıcı bilgi alır.

### 3.3. Telemetri için saklanır

`bestSignal.mtfAlignment` field'ına `mtfConfirmation.agreement` değeri yazılır
(0-100 arası). signal-tracker → archive → learning katmanı bunu okur; **karar
girdisi değil, telemetri**.

```js
if (bestSignal && mtfConfirmation && mtfConfirmation.agreement != null) {
  bestSignal.mtfAlignment = mtfConfirmation.agreement;
}
```

---

## 4. Bu kararı değiştirme koşulları

MTF'i ileride sert kapıya çevirmek isteyen herhangi bir öneri **şu kanıtları
sunmadan kabul edilmemelidir:**

1. **Canlı veri kanıtı:** En az 2 hafta kapanmış pozisyon verisi. Mixed/opposed
   MTF durumlarında WR ve PF, aligned durumlardan **anlamlı ölçüde** düşük
   olmalı (örn. WR farkı ≥ 15%, n ≥ 20).
2. **Korelasyon temizliği:** WR farkının HTF Gate, Liga, R:R, sanity, regime
   filtreleri elendikten sonra kalan rezidüelden geldiği gösterilmeli.
   MTF tek başına anlamlı bir sinyal taşımayabilir — diğer filtrelerle
   collinear olabilir.
3. **A/B simülasyon:** Mevcut advisory vs hypothetical hard-veto'nun 2 haftalık
   tarihsel veri üzerinde simülasyonu. Hard-veto'nun **kaçırılan kazançlı
   pozisyon sayısı** ile **engellediği zararlı pozisyon sayısı** karşılaştırılmalı.
4. **Ürün kararı:** Kullanıcı (proje sahibi) onayı. 2026-05-23 kararının açıkça
   revize edilmesi gerekir.

---

## 5. Referans noktaları (kod)

Satır numaraları yerine **fonksiyon + bölüm marker** kullanıyor; refactor
satırları kaydırsa bile referanslar bozulmaz. Aramak için `grep` veya IDE
"go to symbol".

| Konu | Dosya | Aranan marker | Açıklama |
|---|---|---|---|
| `mtfConfirmation` hesaplama | [scanner-engine.js](../scanner/lib/scanner-engine.js) | `_scanShortTermInner` içinde `let mtfConfirmation = null;` | %75 eşik hesabı |
| `mtfAlignment` telemetri set | [scanner-engine.js](../scanner/lib/scanner-engine.js) | `bestSignal.mtfAlignment = mtfConfirmation.agreement` | post-hoc telemetri |
| Reasoning satırı (advisory) | [scanner-engine.js](../scanner/lib/scanner-engine.js) | `advisory (grade korundu)` (grep) | grade DOKUNULMAZ |
| Grader input mtfAlignment | [scanner-engine.js](../scanner/lib/scanner-engine.js) | `mtfAlignment Faz 2 Commit 4'te` (yorum) | per-TF gradde null; post-hoc set |
| HTF Gate (ayrı katman, MTF ile karıştırma) | [scanner-engine.js](../scanner/lib/scanner-engine.js) | `HTF GATE [4H]` (grep) | bu MTF DEĞİL — üst TF trend teyidi |

---

## 6. Açık konular

- **C13 niyet (Patch 1 turunda Codex tarafından flagged):** "mtfAlignment per-TF
  grader-input'ta null veriliyor, sonra `bestSignal` üzerine post-hoc yazılıyor.
  Bu **karar girdisi mi telemetri mi** belirsizliği vardı." Bu doc kararı
  kesinleştiriyor: **telemetri**. mtfAlignment grader'ın grade kararını
  etkilememeli.
- İleride two-pass (önce direction, sonra grade) grader tasarımı önerilirse,
  bu doc'taki tetikleyici koşullar (Bölüm 4) sağlanmadan kabul edilmemeli.
