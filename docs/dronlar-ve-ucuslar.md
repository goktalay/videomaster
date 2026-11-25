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

Haritanın / kameranın üstünde iki ayrı yüzen panel vardır. Üstteki panel temel telemetriyi gösterir: uçuş kipi ve motor durumu, yükseklik, hız,
tırmanma, yön, eve uzaklık, batarya (gerilim ve yüzde), GPS (uydu sayısı ve konum türü) ve uçuş süresi. Alttaki çubuk temel uçuş
komutlarını verir; üst paneldeki ok bu çubuğu gizler. Paneller tam ekranda da görünür.

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
| **Ekranı kaydet** | Uçuş penceresinin tamamını (harita, kamera, HUD, paneller) videoya kaydeder; yeniden basınca durur. Dosya kayıt klasöründe uçuşun adıyla açılan klasöre `ekran-TARİH-SAAT.mp4` olarak yazılır. Ses kaydedilmez. |

- Komutlar ArduPilot ve PX4 içindir. Betaflight kumandadan uçurulur; panelde komut görünmez.
- "Noktaya git" ve "İrtifa" için aracın havada olması gerekir. Araç bir komutu reddederse nedeni (örn. kurma öncesi denetim iletisi) bildirim olarak görünür.
- İrtifalar kalkış noktasına göredir.

Bilinmesi gerekenler:

- Harita karoları internetten iner: uydu görüntüsü Esri World Imagery, sokak haritası OpenStreetMap.
  Bu servislerin kendi kullanım koşulları vardır; çevrimdışıyken harita boş kalır ama dron ve izi çizilir.
- Dronun haritadaki yüksekliği kalkış noktasına göredir. 3B görünüm eğik bakıştır; arazinin kabartması (dağ, vadi) çizilmez.
- Kendi karo sunucunuzu (çevrimdışı ya da kurum içi harita) kullanmak için ayar dosyasına
  `"flightTiles": { "sat": "http://127.0.0.1:8080/sat/{z}/{x}/{y}.png", "street": "…" }` eklenebilir.

## Görevler

**Görevler** bölümünde görev planları oluşturulur ve saklanır (hesapla eşitlenir). Bir görevi çift tıklayınca harita üzerindeki
görev düzenleyici açılır; çalışma biçimi QGroundControl'ün Plan görünümüne benzer.

**Soldaki araçlar**

| Araç | Ne yapar |
| --- | --- |
| Seç / taşı | Öğeleri seçer; noktalar, ev konumu, çit köşeleri ve toplanma noktaları sürüklenerek taşınır. |
| Nokta ekle | Tıklanan yere görev noktası ekler. Kopter ve uçakta ilk noktadan önce **Kalkış** kendiliğinden eklenir. |
| İlgi noktası | Kameranın / burnun bakacağı nokta (ROI). |
| Alan taraması | Çizilen çokgenin içini gidiş-dönüş hatlarla doldurur: irtifa, hat aralığı, hat yönü, dönüş payı, fotoğraf aralığı. |
| Koridor | Çizilen yol boyunca paralel hatlar: genişlik ve hat aralığı. |
| Çevre turu | Bir noktanın çevresinde daire: yarıçap, nokta sayısı, yön; isteğe bağlı merkeze bakış (ROI). |
| Çit alanı / Çit dairesi | Coğrafi çit: "içinde kal" ya da "girme" alanları. |
| Toplanma noktası | Eve dönüşte kullanılabilecek yedek nokta. |
| Ev konumu | Planlanan kalkış noktası. |
| Ölç | Haritada mesafe ölçer. |

Çok noktalı araçlarda noktalar tıklanır; **çift tıklama ya da Enter** bitirir, **Geri** son noktayı siler, **Esc** vazgeçer.

**Sağ panel**: görev ayarları (varsayılan irtifa, seyir hızı, ev konumu), uyarılar, komut ekleme ve öğe listesi. Seçili öğenin komutu,
konumu, irtifası, irtifa başvurusu (kalkış noktası / deniz seviyesi / arazi) ve komuta özgü değerleri düzenlenir; öğeler yukarı-aşağı
taşınır, kopyalanır, silinir. Tarama gibi üreteçlerin oluşturduğu noktalar bir grup sayılır ve **Grubu sil** ile birlikte silinir.
Çit ve toplanma noktalarının ayrı sekmeleri vardır.

**Komutlar**: kalkış, görev noktası, eğri (spline) nokta, süreli / turlu / süresiz bekleme, iniş, eve dönüş, VTOL kalkış ve iniş,
gecikme, hız ve yön değiştirme, ROI ve ROI iptali, öğeye atlama (tekrarlı), mesafeyle fotoğraf, fotoğraf / video başlat-durdur,
gimbal yönü, servo, röle, tutucu, irtifa değiştirme, iniş başlangıcı. Liste araç türüne göre (kopter, uçak / VTOL, kara / deniz
aracı, denizaltı) değişir.

**Ayrıca**: üstte toplam yol, tahmini süre, evden en uzak nokta ve en yüksek irtifa; altta yükseklik profili; geri al / yinele
(Ctrl+Z / Ctrl+Y); değişiklikler kendiliğinden kaydedilir.

**Dosyalar**: QGroundControl `.plan` ve Mission Planner `.waypoints` dosyaları alınır ve aynı biçimlerde kaydedilir. QGroundControl'ün
tarama öğeleri içlerindeki noktalara açılarak alınır.

**Araç**: üstten bir dron seçip **Araca yükle**, **Araçtan oku** ya da araçtaki görevi sil. Dron bağlı değilse bu iş için
bağlanılır ve iş bitince bağlantı bırakılır. Görevle birlikte çit ve toplanma noktaları da aktarılır.

### Uçuş penceresinde görev

Alttaki çubukta **Görev** düğmesi: kayıtlı bir görevi araca yükleme, araçtaki görevi okuma, **görevi başlatma** (onay ister; motorları
etkinleştirir ve AUTO / Mission kipine geçer), **duraklatma**, **sürdürme**, **görev noktasına gitme** (sıradaki öğeyi değiştirir) ve
araçtaki görevi silme. Yüklü görev haritada kesikli çizgi ve numaralı noktalarla, sıradaki nokta vurgulu gösterilir; telemetri
panelinde "sıradaki / toplam" görünür.

### Görevlerde olmayanlar

QGroundControl'deki şu özellikler bu sürümde yoktur: arazi yüksekliği verisi (yükseklik profili arazi çizmez, araziyi izleyen
tarama yoktur), kamera modeline göre otomatik hat aralığı / örtüşme hesabı, yapı taraması (çok katmanlı), sabit kanat iniş deseni
üreteci, tarama öğesini sonradan yeniden ayarlama (silip yeniden üretilir), çevrimdışı harita indirme.

## Uçuş kayıtları ve oynatma

Dron bağlıyken bütün telemetri kendiliğinden kaydedilir: konum, yükseklik, hız, yönelim, batarya, GPS, kumanda ve motor
değerleri, uçuş kipi, motor durumu ve aracın durum iletileri (saniyede en çok 10 kayıt).

- Kayıt, araçtan veri gelmeye başlayınca açılır ve **bağlantı kesilince kapanır**; yeniden bağlanınca **yeni bir kayıt** başlar.
  2 saniyeden kısa kayıtlar saklanmaz.
- Dron kartının üstündeki **saat düğmesi** (ya da sağ tık → Uçuş kayıtları) o dronun kayıtlarını listeler: tarih, süre, uçuş
  süresi, en yüksek irtifa, katedilen yol. **Oynat** kaydı bir uçuş penceresinde gerçek uçuşmuş gibi gösterir: harita, iz, HUD
  ve telemetri paneli kayda göre ilerler; durum iletileri bildirim olarak çıkar.
- Oynatıcı alttaki çubuktadır: oynat / duraklat, ileri-geri sarma, 1×–16× hız. Oynatma sırasında uçuş komutları gösterilmez;
  **Ekranı kaydet** kullanılabilir. Oynatılan kayıt yeniden kaydedilmez.
- Dosyalar uygulamanın veri klasöründe `logs/<dron>/TARİH-SAAT.vmlog.gz` olarak durur (gzip'li, satır başına bir JSON);
  listedeki **Kayıt klasörünü aç** düğmesi klasörü açar. Kayıtlar hesapla eşitlenmez, yalnızca bu bilgisayardadır.
- Ham MAVLink paketleri (`.tlog`) kaydedilmez; kayıtlar Mission Planner'da açılamaz.

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
- Araçtaki uçuş günlüğünü (dataflash / ulog) indirme ve yazılım yükleme bu sürümde yoktur.
- Betaflight sürücüsü sahte bir kartla sınandı; gerçek kartla ve gerçek Betaflight SITL ile denenmedi. Seri portta yeniden başlatma
  sonrası kendiliğinden yeniden bağlanma denenmedi.
- Haberleşme çekirdeği benzetimle ve bağımsız bir MAVLink kitaplığıyla (pymavlink) sınandı; gerçek ArduPilot/PX4 donanımıyla denenmedi.
- PX4 kalibrasyon akışı ve motor düzeni okuması yalnızca kaynak kodundan çıkarıldı.
