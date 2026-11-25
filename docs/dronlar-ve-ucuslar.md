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

## Ayarlar (temel uçuş ayarları)

Dron penceresindeki **Ayarlar** modülü, en çok kullanılan uçuş ayarlarını parametre adlarıyla uğraşmadan, Türkçe açıklamalar ve
göstergelerle sunar (ArduPilot ve PX4; Betaflight'ta yoktur). Sekiz grup vardır: **Hız**, **Kalkış**, **İniş**, **Eve dönüş**,
**Güvenlik ve arıza davranışı**, **Coğrafi çit**, **Kumanda hissi** ve **Uçuş kipleri**. ArduCopter'da 75 ayar görünür; araçta
karşılığı olmayan ayarlar gizlenir.

- Her ayarın kendi kartı vardır: gösterge (hız kadranı, irtifa çubuğu, batarya, süre…), değer, kaydırıcı ve ne işe yaradığını,
  yükseltince / düşürünce ne olacağını anlatan açıklama.
- Bir ayar arka planda birden çok parametreyi değiştirebilir. **Değişecek parametreler** listesi hangi parametrenin hangi
  değerden hangisine geçeceğini ve bağlı değişikliklerin nedenini gösterir (örneğin görev hızını yükseltmek ivmeyi ve gerekiyorsa
  azami yatış açısını da yükseltir).
- **Uçuş karakteri** (Sakin / Normal / Hızlı / Çok hızlı) ve **İniş karakteri** (Yumuşak / Normal / Hızlı) hazır takımlardır;
  hız, ivme ve yatış değerlerini birbirine uyumlu biçimde tek seferde ayarlar.
- Değişen kartlar işaretlenir; kart başına **Uygula** ya da alttaki **Tümünü uygula** ile araca yazılır. Güvenliği azaltan
  seçimler (kurma denetimlerini kapatmak, arıza davranışını ya da çiti devre dışı bırakmak gibi) ayrıca onay ister.
- Üstteki arama kutusu bütün gruplarda arar.

Parametre adları, birimleri ve aralıkları ArduCopter 4.5 ve PX4 1.14'e göre yazılmıştır ve yalnızca depodaki benzetimli
ArduCopter ile sınanmıştır; başka sürümlerde bir ayarın karşılığı farklıysa Parametreler modülünden denetleyin.

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

- **Harita (Cesium küresi)**: dron 3B modeliyle (kopter, uçak, helikopter… araç türüne göre), uçulan yol irtifasıyla, yere
  izdüşüm çizgisi, kalkış noktası, hedef ve görev yolu gerçek arazi kabartmalı kürenin üstünde gösterilir. Fareyle döndürülür,
  eğilir, yakınlaştırılır; "dronu izle" açıkken kamera seçtiğiniz bakış açısını koruyarak aracı izler.
- **Harita ayarları** (harita araçlarındaki katman düğmesi; bütün haritalarda ortaktır): harita kaynağı, arazi kabartması,
  sahne ayarları ve çevrimdışı harita. Ayrıntılar aşağıda, "Harita altyapısı" başlığında.
- **2B yedek harita**: Cesium (WebGL) bilgisayarda açılamazsa uygulama kendiliğinden sade 2B haritaya geçer; karolar, dron ve
  yönü, iz, kalkış noktası, hedef ve noktaya git orada da çalışır.
- **Yerleşimler**: harita + küçük kamera, kamera + küçük harita, yan yana, yalnız harita, yalnız kamera. Küçük pencereye tıklamak
  büyüğüyle yer değiştirir. Kamera ve harita ayrı ayrı tam ekran açılabilir (HUD ile birlikte).
- **HUD**: yapay ufuk ve yunuslama merdiveni, yatış ölçeği, hız ve yükseklik şeritleri, tırmanma göstergesi, yön şeridi; altta uçuş
  kipi, motor durumu, batarya, GPS, kalkış noktasına uzaklık, gaz.
- **HUD görünümleri** (üst çubuktaki gösterge düğmesi): **Transparan** (görüntünün üstüne çizilen şeritler), **Göstergeler**
  (yüzen küçük panelde yapay ufuk küresi ve pusula; altında hız, yükseklik, tırmanma), **Küçük** (yalnız yapay ufuk) ve **Kapalı**.
- **Telemetri çubuğunu düzenleme**: çubuktaki dişli düğmesi gösterilecek kutuları ve sıralarını seçtirir. Seçenekler: yükseklik,
  rakım, yer hızı, hava hızı, tırmanma, yön, eve uzaklık, hedefe uzaklık, batarya, akım, GPS, HDOP, uçuş süresi, görev, gaz,
  yatış, yunuslama, kumanda sinyali, konum.
- **Dron ekranı** (üst çubuktaki dişli): aynı bağlantıyı ve telemetriyi kullanan dron penceresini açar; uçuş sürerken parametre,
  ayar ve kalibrasyon ekranlarına geçilebilir. Dron penceresi kapatılınca uçuşun bağlantısı sürer.
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

- Çevrimdışıyken önbellekteki yerler açılır; önbellekte olmayan yerlerde harita boş kalır ama dron ve izi çizilir.
- Dronun haritadaki yüksekliği kalkış noktasına göredir: kalkış noktasının arazi yüksekliği örneklenir ve uçuş irtifası
  onun üstüne eklenir.

## Harita altyapısı

Uçuş penceresi ve görev düzenleyici aynı harita altyapısını kullanır (Göktungu yer istasyonundakiyle aynı düzen):

- **Motor**: CesiumJS küresi. Görev düzenleyici üstten bakışla açılır ve çizimler araziye oturtulur.
- **Harita kaynakları** (12): ESRI Uydu / Sokak / Topografik, Google Uydu / Hibrit / Yol / Arazi, Bing Uydu, OpenStreetMap,
  OpenTopoMap, CartoDB Açık / Koyu.
- **Karo önbelleği**: bütün karolar uygulamanın kendi önbelleğinden geçer. Bir kez görüntülenen her yer diske yazılır
  (veri klasöründe `tiles/<kaynak>/<z>/<x>/<y>.tile`) ve internet yokken oradan açılır; ayrı bir "çevrimdışı kip" yoktur.
- **Görünen bölgeyi indir**: haritada görünen bölge, seçilen yakınlaştırma aralığında önceden indirilir. Önce karo sayısı,
  tahmini süre ve boyut gösterilir; ilerleme, hız ve kalan süre izlenir; indirme durdurulabilir. Tek indirmede en çok 250.000
  karo. Önbellekteki karolar yeniden indirilmez. Kaynak başına karo sayısı, boyut, yakınlaştırma aralığı ve son indirme
  tarihi listelenir; kaynak kaynak ya da tümüyle silinebilir.
- **Arazi kabartması**: Kapalı, **ArcGIS World Elevation** (anahtarsız; varsayılan) ya da **Cesium World Terrain** (Cesium ion
  erişim anahtarı ister). Anahtar harita ayarlarından girilir, yalnızca bu bilgisayardaki ayarlarda saklanır ve hesapla
  eşitlenmez. Arazi verisi alınamazsa küre düz gösterilir. Arazi kabartması çevrimdışı saklanmaz.
- **Sahne**: arazi abartması, atmosfer, sis, güneş aydınlatması, kenar yumuşatma, çözünürlük ölçeği.
- **Özel karo sunucusu**: ayar dosyasında `"flightTiles": { "esri": "http://sunucu/{z}/{x}/{y}.png", … }` ile bir kaynağın
  adresi değiştirilebilir (`sat` ve `street` adları ESRI Uydu ve OpenStreetMap için de geçerlidir; `dem` yükseklik karolarıdır).

Harita sağlayıcılarının (Esri, Google, Microsoft, OpenStreetMap…) kendi kullanım koşulları vardır; bunlar özellikle toplu
indirmeyi ve çevrimdışı saklamayı kısıtlayabilir. Uygun kullanım kullanıcının sorumluluğundadır.

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

### Arazi, kamera, desenler ve çevrimdışı harita

- **Arazi yüksekliği**: yükseklik profili yolun altındaki araziyi çizer (deniz seviyesine göre) ve en az açıklığı yazar; yol
  araziye 10 m'den yakın geçiyorsa ya da kesişiyorsa panelde uyarı çıkar. **Noktaları araziye göre ayarla** bütün gezinme
  noktalarını yerden verilen yükseklikte olacak biçimde değiştirir. Veri AWS Terrain Tiles'tan (yaklaşık 30 m çözünürlük) gelir;
  bina ve ağaçları içermez, güvenlik payını buna göre bırakın.
- **Araziyi izleyen tarama**: alan taraması ve koridorda "Araziyi izle" seçilirse hatlar boyunca ara noktalar eklenir ve her
  noktanın irtifası yerden sabit yükseklikte kalacak biçimde hesaplanır.
- **Kameraya göre hat aralığı**: taramada "Kameraya göre" seçilince kamera (ya da özel algılayıcı / odak değerleri), yan ve ön
  örtüşme girilir; hat aralığı, fotoğraf aralığı, yer çözünürlüğü (cm/piksel) ve kare boyutu hesaplanır. Hazır kamera
  değerleri üretici verilerinden alınmıştır; kendi kameranız için değerleri doğrulayın.
- **Yapı taraması**: bir merkezin çevresinde alt ve üst yükseklik arasında katman katman turlar; isteğe bağlı merkeze bakış.
- **İniş deseni** (araç türü uçakken): iniş noktası, iniş yönü, yaklaşma mesafesi ve irtifası → iniş başlangıcı, irtifaya
  kadar tur ve iniş öğeleri; süzülüş açısı gösterilir.
- **Desenleri sonradan düzenleme**: tarama, koridor, çevre turu, yapı taraması ve iniş deseni tanımlarıyla saklanır. Desenin
  bir noktası seçilince **Deseni düzenle** aynı pencereyi açar; desenin köşeleri ya da merkezi haritada sürüklenince noktalar
  yeniden üretilir.
- **Çevrimdışı harita**: harita araçlarındaki katman düğmesiyle açılan ortak harita ayarlarından yapılır (bkz. "Harita
  altyapısı"). Yükseklik profili ve araziyi izleme için kullanılan yükseklik karoları da görüntülendikçe önbelleğe alınır.

Sınırlar: arazi verisi yapıları ve bitki örtüsünü içermez; yapı taraması dairesel turlardır (çokgen cepheli tarama yoktur);
kamera hesabı yatay çekimi ve düz araziyi varsayar.

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
