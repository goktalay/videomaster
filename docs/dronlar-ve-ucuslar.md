# Dronlar ve uçuşlar

Ana ekran üç bölümdür: **Kameralar** (akışlar, kamera kontrol, yapay görü), **Dronlar** (uçuş kontrolcüleri) ve
**Uçuşlar** (dron + kamera + harita).

## Dron ekleme

Bağlantı Mission Planner'daki gibi tanımlanır:

| Bağlantı | Ne yapar | Tipik kullanım |
|---|---|---|
| Seri port | COM portu ve hız (baud) | USB kablo, telemetri radyosu |
| TCP | Adrese bağlanır | ArduPilot SITL (127.0.0.1:5760), ağ köprüleri |
| UDP | Dronun adresine gönderir | Dron belirli bir portta dinliyorsa |
| UDPIN | Portu dinler (varsayılan 14550) | Dron ya da SITL bu bilgisayara gönderiyorsa |

Yazılım türleri: **ArduPilot**, **PX4**, **SITL** (benzetim; MAVLink) ve **Betaflight**. Betaflight farklı bir protokol
(MSP) kullandığı için bu sürümde yalnızca kaydedilebilir; bağlantısı sonraki sürümde.

## Dron penceresi

- **Solda modüller**
  - *Genel bakış*: araç türü, sürüm, uçuş kipi, gövde yapısı, konum, batarya, algılayıcı durumu, dron iletileri, yeniden başlatma.
  - *Parametreler*: bütün parametreler drondan okunur ve ön eke göre ağaç olarak gruplanır. Ad ve açıklamada arama, seçenekli
    ve bit maskeli parametreler için hazır listeler, aralığı bilinenlerde kaydırıcı. Açıklamalar arayüz dilinde (Türkçe çevirisi
    olanlar Türkçe, "Özgün metin" altında İngilizcesi) gösterilir. Değişiklikler tek tek ya da topluca yazılır; liste dosyaya
    kaydedilir ve dosyadan yüklenir (Mission Planner `.param` biçimi).
  - *Motor testi*: gövde yapısı (FRAME_CLASS / FRAME_TYPE, PX4'te CA_ROTOR*) okunur; motorlar gerçek konumları, dönüş yönleri
    ve test sırası harfleriyle çizilir. Bir motora basınca o motor seçilen gaz ve sürede döner. Önce pervanelerin çıkarıldığı onaylanır.
  - *Kalibrasyonlar*: ivmeölçer (6 konum), seviye, jiroskop, pusula (ilerleme çubuklarıyla), barometre, kumanda (uç değerler), ESC.
- **Sağda telemetri**: yükseklik, yer hızı, tırmanma, yatış, yunuslama, yön, gaz, batarya gerilimi, akım, uydu sayısı çizgi grafikleri.
- **Altta haberleşme günlüğü**: gelen ve giden her MAVLink iletisi. Arama kutusunda sözcükler boşlukla ayrılır; başına `-` konan
  sözcük dışarıda bırakılır (ör. `PARAM -HEARTBEAT`). Gelen/giden süzgeci, duraklatma, temizleme.
- Üst çubuk: bağlan/kes, uçuş kipi seçimi, motorları etkinleştir/kapat.

Parametre açıklamaları ArduPilot'un kendi kaynak kodundan ve PX4'ün yayımladığı parametre listesinden üretilir
(Copter, Plane, Rover, Sub, PX4). Türkçe çeviri önce Copter için yapılmıştır; çevirisi olmayan metinler özgün haliyle gösterilir.

## Uçuşlar

**Yeni uçuş** kayıtlı bir dron ve (isteğe bağlı) kayıtlı bir kamera seçtirir. Uçuş penceresinde:

- **3B harita**: dronun konumu ve yönü, uçulan yüksekliğe kadar yükselen iz, kalkış noktası. Uydu görüntüsü / sokak haritası,
  3B arazi ve eğik bakış, dronu izleme, kalkış noktasına gitme, izi temizleme.
- **Yerleşimler**: harita + küçük kamera, kamera + küçük harita, yan yana, yalnız harita, yalnız kamera. Küçük pencereye tıklamak
  büyüğüyle yer değiştirir. Kamera ve harita ayrı ayrı tam ekran açılabilir (HUD ile birlikte).
- **HUD**: yapay ufuk ve yunuslama merdiveni, yatış ölçeği, hız ve yükseklik şeritleri, tırmanma göstergesi, yön şeridi; altta uçuş
  kipi, motor durumu, batarya, GPS, kalkış noktasına uzaklık, gaz.
- **Kamera paneli** (dişli düğmesi): akış penceresindeki bütün özellikler — akış ayarları, kamera kontrol, yapay görü; ayrıca
  kayıt, anlık görüntü, ses ve akış verisi paneli.

Bilinmesi gerekenler:

- Harita karoları internetten iner: uydu görüntüsü Esri World Imagery, sokak haritası OpenStreetMap, arazi yüksekliği
  AWS Terrain Tiles. Bu servislerin kendi kullanım koşulları vardır; çevrimdışıyken harita boş kalır ama dron ve izi çizilir.
- Dronun haritadaki yüksekliği kalkış noktasına göredir (arazi üstü gerçek yükseklik değil).

## Geliştirme: benzetimli dron

Gerçek dron olmadan denemek için depoda sahte bir ArduCopter vardır:

```bash
node scripts/sim-drone.js
```

Varsayılan olarak 127.0.0.1:14550'ye UDP gönderir (uygulamada **UDPIN 14550**) ve TCP 5760'ı dinler (**TCP 127.0.0.1:5760**).

## Sınırlar

- Betaflight bağlantısı, görev planlama, coğrafi çit, uçuş günlüğü indirme ve yazılım yükleme bu sürümde yoktur.
- Haberleşme çekirdeği benzetimle ve bağımsız bir MAVLink kitaplığıyla (pymavlink) sınandı; gerçek ArduPilot/PX4 donanımıyla denenmedi.
- PX4 kalibrasyon akışı ve motor düzeni okuması yalnızca kaynak kodundan çıkarıldı.
