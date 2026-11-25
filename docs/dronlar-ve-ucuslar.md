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

Yazılım türleri: **ArduPilot**, **PX4**, **SITL** (benzetim; MAVLink) ve **Betaflight** (MSP + komut satırı; seri port ya da
Betaflight SITL için TCP 127.0.0.1:5761).

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
(Copter, Plane, Rover, Sub, PX4). Türkçe çeviri Copter, Rover ve Sub için tamdır, Plane için yaklaşık %85'tir; PX4 açıklamaları
ve çevirisi olmayan metinler özgün haliyle (İngilizce) gösterilir.

## Betaflight

Betaflight kartları MSP protokolüyle bağlanır; aynı dron penceresi kullanılır, şu farklarla:

- **Genel bakış**: kart, sürüm, gövde yapısı, algılayıcılar ve **motorların etkinleşmesini engelleyen** durumlar (RXLOSS, ARMSWITCH…).
  Motorlar ve uçuş kipi kumandadan yönetilir; pencerede düğmeleri yoktur.
- **Parametreler**: kartın bütün ayarları komut satırından (`get`) okunur: aralık, seçenekler ve varsayılan değerle birlikte.
  Betaflight ayarlarının resmî açıklama metni olmadığı için açıklama gösterilmez. Yazılan değerler **Kaydet ve yeniden başlat** ile
  kalıcı olur. Liste `set ad = değer` satırlarıyla dosyaya kaydedilir ve yüklenir.
- **Motor testi**: Betaflight motor numaraları ve dönüş yönleriyle (yaw_motors_reversed dahil). Kartın kendi zaman aşımı yoktur:
  uygulama ya da bağlantı test sırasında kesilirse motor dönmeye devam eder; pervaneleri mutlaka sökün.
- **Kalibrasyonlar**: ivmeölçer ve pusula.
- **Komut satırı (CLI)**: kartın her komutuna doğrudan erişen konsol (`status`, `diff all`, `dump`, `resource`, `set …`, `save`…).

CLI kipindeyken (parametre okuma/yazma ve konsol) telemetri durur. Betaflight 4.5 ve sonrası CLI'dan yeniden başlatmadan
çıkabilir; daha eski sürümlerde çıkış kartı yeniden başlatır. Her sürümde, CLI'ya bir kez girildikten sonra kart yeniden
başlatılana kadar motorların etkinleşmesine izin vermez.

## Uçuşlar

**Yeni uçuş** kayıtlı bir dron ve (isteğe bağlı) kayıtlı bir kamera seçtirir. Uçuş penceresinde:

- **3B harita**: dronun konumu ve yönü, uçulan yüksekliğe kadar yükselen iz, kalkış noktası. Uydu görüntüsü / sokak haritası,
  3B eğik bakış ya da üstten bakış, dronu izleme, kalkış noktasına gitme, izi temizleme.
- **2B harita**: 3B harita (WebGL) bilgisayarda açılamazsa uygulama kendiliğinden sade 2B haritaya geçer; harita araçlarındaki
  düğmeyle elle de geçilebilir. 2B haritada da her şey çalışır: karolar, dron ve yönü, iz, kalkış noktası, hedef, noktaya git.
- **Yerleşimler**: harita + küçük kamera, kamera + küçük harita, yan yana, yalnız harita, yalnız kamera. Küçük pencereye tıklamak
  büyüğüyle yer değiştirir. Kamera ve harita ayrı ayrı tam ekran açılabilir (HUD ile birlikte).
- **HUD**: yapay ufuk ve yunuslama merdiveni, yatış ölçeği, hız ve yükseklik şeritleri, tırmanma göstergesi, yön şeridi; altta uçuş
  kipi, motor durumu, batarya, GPS, kalkış noktasına uzaklık, gaz.
- **Kamera paneli** (dişli düğmesi): akış penceresindeki bütün özellikler — akış ayarları, kamera kontrol, yapay görü; ayrıca
  kayıt, anlık görüntü, ses ve akış verisi paneli.

### Yüzen panel: telemetri ve uçuş işlemleri

Haritanın / kameranın üstünde yüzen panelin üst satırı temel telemetriyi gösterir: uçuş kipi ve motor durumu, yükseklik, hız,
tırmanma, yön, eve uzaklık, batarya (gerilim ve yüzde), GPS (uydu sayısı ve konum türü) ve uçuş süresi. Alt satır temel uçuş
komutlarını verir; sağdaki ok bu satırı gizler. Panel tam ekranda da görünür.

| Düğme | Ne yapar |
| --- | --- |
| **Motorları etkinleştir / kapat** | Kurma (onay ister) ve çözme. Havadayken çözmeyi uçuş kartı reddeder. |
| **Kalkış** | İrtifa sorar; aracı GUIDED kipine alır, motorları etkinleştirir ve o irtifaya yükseltir. ArduPlane'de TAKEOFF kipi kullanılır (irtifa aracın `TKOFF_ALT` ayarından gelir). |
| **İniş** | Bulunduğu yere iner (kopter: LAND, VTOL: QLAND, PX4: Land). |
| **Eve dön** | Kalkış noktasına döner (RTL / PX4: Return). |
| **Bekle** | Olduğu yerde durur: kopter BRAKE (yoksa LOITER), uçak LOITER, kara aracı HOLD, PX4 Hold. |
| **Uçuş kipi** | Aracın bütün kipleri; seçilen kipe geçer. |
| **Noktaya git** | Düğmeye basıp haritada bir noktayı tıklayın (ya da haritaya sağ tıklayın). Araç bulunduğu irtifada o noktaya gider; hedef ve kalan uzaklık gösterilir. |
| **İrtifa** | Bulunduğu konumda yeni irtifaya çıkar / iner. |
| **Acil durdur** | Onaydan sonra motorları hemen keser. **Araç havadaysa düşer**; yalnız acil durumda kullanın. |

- Komutlar ArduPilot ve PX4 içindir. Betaflight kumandadan uçurulur; panelde komut görünmez.
- "Noktaya git" ve "İrtifa" için aracın havada olması gerekir. Araç bir komutu reddederse nedeni (örn. kurma öncesi denetim iletisi) bildirim olarak görünür.
- İrtifalar kalkış noktasına göredir.

Bilinmesi gerekenler:

- Harita karoları internetten iner: uydu görüntüsü Esri World Imagery, sokak haritası OpenStreetMap.
  Bu servislerin kendi kullanım koşulları vardır; çevrimdışıyken harita boş kalır ama dron ve izi çizilir.
- Dronun haritadaki yüksekliği kalkış noktasına göredir. 3B görünüm eğik bakıştır; arazinin kabartması (dağ, vadi) çizilmez.
- Kendi karo sunucunuzu (çevrimdışı ya da kurum içi harita) kullanmak için ayar dosyasına
  `"flightTiles": { "sat": "http://127.0.0.1:8080/sat/{z}/{x}/{y}.png", "street": "…" }` eklenebilir.

## Geliştirme: benzetimli dron

Gerçek dron olmadan denemek için depoda sahte bir ArduCopter vardır:

```bash
node scripts/sim-drone.js
```

Varsayılan olarak 127.0.0.1:14550'ye UDP gönderir (uygulamada **UDPIN 14550**) ve TCP 5760'ı dinler (**TCP 127.0.0.1:5760**).

Varsayılan benzetim sürekli daire çizer. Uçuş işlemlerini denemek için aracı yerde başlatan ve komutlara uyan kipi kullanın:

```bash
node scripts/sim-drone.js --interactive
```

## Sınırlar

- Uçuş komutları (kalkış, noktaya git, iniş…) yalnızca depodaki benzetimli araçla sınandı; gerçek ArduPilot / PX4 kartıyla ya da
  gerçek SITL ile denenmedi. İlk denemeyi pervanesiz ya da benzetimde yapın.
- Görev planlama, coğrafi çit, uçuş günlüğü indirme ve yazılım yükleme bu sürümde yoktur.
- Betaflight sürücüsü sahte bir kartla sınandı; gerçek kartla ve gerçek Betaflight SITL ile denenmedi. Seri portta yeniden başlatma
  sonrası kendiliğinden yeniden bağlanma denenmedi.
- Haberleşme çekirdeği benzetimle ve bağımsız bir MAVLink kitaplığıyla (pymavlink) sınandı; gerçek ArduPilot/PX4 donanımıyla denenmedi.
- PX4 kalibrasyon akışı ve motor düzeni okuması yalnızca kaynak kodundan çıkarıldı.
