<!--
  Otonom uretildi: 2026-05-11T22:27 UTC (`scanner/scripts/regime-report.mjs --days=10`)
  Pencere: Faz 2 wrapper live'a gectikten sonra ikinci kalibrasyon donemi —
  compute-regime bootstrap/subRegime/BIST profile fix'leri (commit ef98285,
  2026-05-09) sonrasi gercek dagilimi yansitir. Week-1 raporu
  (docs/regime-report-week1.md) hatali kod uzerinde alinmis, kalibrasyon
  amaciyla kullanilamaz.
-->

# Regime Shadow Mode — 2. Ara Rapor (Hafta-2)

**Donem**: 2026-05-02 → 2026-05-11 (10 gun, 3.416 kayit)

## Yonetici ozeti

Compute-regime fix'leri calisti. Tum piyasalar artik cesitlilik gosteriyor;
week-1'in "her sembol her zaman ranging" hatasi giderildi. Kalibrasyon
acisindan gozlemler:

| Metrik | Week-1 (hatali) | Week-2 (fix sonrasi) | Yorum |
|---|---|---|---|
| Crypto ranging | 100% | 53% | Saglikli ✅ |
| Crypto chaos | 0% | 38% | Saglikli, May 6-10 BTC chaos donemini yakaladi ✅ |
| Crypto trending | 0% | 9% | Az ama makul (BTC short trendi 0.2% — incelenmesi gerek) ⚠️ |
| BIST cesitlilik | 100% ranging | 65% ranging + 35% trending | Saglikli ✅ |
| False-flip orani | 82.7% | 50% | Self-loop'lar gitti; gercek micro-transition'lar kaldi ⚠️ |
| Chaos veri | yok | 36 olay, gercek median 1668 dk | Taxonomy tahmini 15× sapiyor ⚠️ |
| BIST sub-regime | %100 stable_domestic | %100 stable_domestic | Hala stuck — bug supheli ❌ |

## Olas? aksiyonlar (oncelik sirasiyla)

1. **BIST sub-regime stuck bug** (Bolum 5): tum 748 BIST kaydinda hala
   `bist_tl_stable_domestic`. Compute-regime "sticky subRegime" fix'i (commit
   ef98285) yapildigi halde sonuc degismedi → makro alanlari (usdtry sigma,
   usdtry-bist rho) muhtemelen scanner-engine'den compute-regime'e
   ulasmiyor. 5-10 dk'lik tek dosya inceleme.

2. **Chaos suresi taxonomy kalibrasyonu** (Bolum 4): gercek ortalama
   2.334 dk (~39 saat), taxonomy 121 dk varsayiyor. `config/chaos-windows.json`
   yeni medianlara gore guncellenmeli.

3. **N=4 histerezis denemesi** (Bolum 2): false-flip orani %50, N=4
   simulasyonu %14.5'ini bastiriyor. Trade-off: chaos disindaki gecislerde
   1 bar gecikme. Chaos zaten chaosImmediate ile bypass yapildigindan
   guvenlik kaybi yok. Risk Matrix Risk #4'un "Yuksek olasilik > N=4'e cik"
   tetikleyicisi yakinda.

4. **breakout_pending + low_vol_drift sifir tetik** (Bolum 1): hicbir
   piyasada gorulmedi. `bbWidthRatio < 0.7` esigi cok dar olabilir;
   alternatif: piyasa kosulu gercekten breakout-uretmedi. 1-2 hafta daha
   gozlem sonrasi karar.

5. **REGIME_GATES kalibrasyonu (Adim 4)**: ranging 1.635 ornek, chaos 736,
   trending_up 350, trending_down 136 — hepsi 30-sample esigini astigi icin
   byRegime ogrenmesi baslayabilir. Bu rapora paralel `weight-adjuster`
   bir sonraki dongusunde adjust uretmeli; ayri bir komut/inceleme gerekir.

---



## 1. Rejim Dagilimi (Piyasa basina)

### crypto (n=1940)
  - ranging: 53.04% (1029)
  - high_vol_chaos: 37.94% (736)
  - trending_up: 8.81% (171)
  - trending_down: 0.21% (4)

### forex (n=132)
  - ranging: 82.58% (109)
  - trending_down: 12.12% (16)
  - trending_up: 5.3% (7)

### bist (n=748)
  - ranging: 65.64% (491)
  - trending_up: 23.26% (174)
  - trending_down: 11.1% (83)

### commodities (n=164)
  - ranging: 79.88% (131)
  - trending_up: 17.68% (29)
  - trending_down: 2.44% (4)

### us_stocks (n=432)
  - ranging: 68.06% (294)
  - trending_up: 22.69% (98)
  - trending_down: 9.26% (40)

## 2. Histerezis False-flip Analizi

- **N=3 (mevcut)**: 86 transition, 43 false-flip → **50%**
- **N=4 simulasyonu**: 159 transition'in 23'i baska bir bar gerektirirdi → 14.47% bastirma

> ⚠️ False-flip > %10 → taxonomy kuralina gore N artirma adayi (N=4 simulasyonu deger katiyorsa).

### Ornek false-flip'ler:
  - BTCUSD|240: trending_up → ranging (3 bar) → trending_up @ 2026-05-07T14:37:34.443Z
  - BTCUSD|1D: high_vol_chaos → trending_up (1 bar) → high_vol_chaos @ 2026-05-08T17:19:19.932Z
  - BTCUSD|1D: trending_up → high_vol_chaos (3 bar) → trending_up @ 2026-05-08T20:10:31.481Z
  - BTCUSD|1D: high_vol_chaos → trending_up (1 bar) → high_vol_chaos @ 2026-05-09T16:39:37.632Z
  - BTCUSD|1D: trending_up → high_vol_chaos (3 bar) → trending_up @ 2026-05-10T17:24:22.710Z

## 3. Rate-limit (Unstable sembol-gun)

- **0** sembol-gun cifti rate-limit'e takildi (>4 gecis)

## 4. Chaos Suresi (Gercek vs Tahmin)

- **Ornek sayisi**: 36
- **Gercek median**: 1668 dk
- **Gercek ortalama**: 2334 dk
- **Maksimum**: 8471.8 dk
- **Taxonomy tahmini ortalama**: 121.3 dk
- **Sapma**: 1825.0%

> ⚠️ Gercek ortalama tahminin %50+ uzerinde — config/chaos-windows.json kalibrasyon gereksinimi.

## 5. BIST `bist_tl_stable_domestic` Sıklığı

- BIST toplam kayit: 748
- `bist_tl_stable_domestic` tetik: 748 → **100%**

---
Uretildi: 2026-05-11T22:27:16.862Z
