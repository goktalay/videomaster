# Kamera modelleri

RTSP bağlantısında **Kamera modeli** varsayılan olarak *Belirsiz model*dir. Bir model seçildiğinde:

- modelin varsayılan adresi, portu ve akış yolu forma uygulanır (girilmiş değerler korunur),
- **Kamera** sekmesinde modele özel ayarlar istenir (kontrol adresi/portu, yerel port, yönlendirme hızı…),
- akış penceresinin sağ panelinde **Kamera kontrol** sekmesi açılır: durum, joystick ve modelin komutları.

| Model | Görüntü | Kontrol | Kaynak |
|---|---|---|---|
| CPDD075CCT | `rtsp://192.168.144.108/live/0` (`/live/1`, `/live/2`) | UDP 9554, yerel 7001; 44 baytlık çerçeve, 25 Hz | Üreticinin belgeleri: teknik şartname V2.0, FPV kullanım kılavuzu, seri haberleşme protokolü V2.14 |
| Skydroid C10 / C10 Pro | `rtsp://192.168.144.108:554/stream=0` | C10: TCP 5000 · C10 Pro: UDP 5000; `#TP` metin protokolü | Skydroid RCSDK v1.9.2 ve rcsdk-demo |
| Skydroid C12 | `:554/stream=1` (görünür), `:555/stream=2` (termal) | UDP 5000, yerel 5000; `#TP` | RCSDK; donanımda doğrulanmış açık kaynak araçlar |
| Skydroid C13 | `:554/stream=1`, `:555/stream=2` | UDP 5000; `#TP` + lazer mesafe, termal sahne | RCSDK; ArduPilot Skydroid sürücüsü |
| Skydroid C20 | `rtsp://192.168.144.108:554/main` | Gimbal TCP 5000 (`#TP`), kamera TCP 8100 (ikili) | RCSDK (donanımda doğrulanmadı) |

## CPDD075CCT

Komut çerçevesi sabit 44 bayttır ve 40 ms'de bir sürekli gönderilir: `FB 2C`, komut kodu, 4 parametre baytı, 30 bayt uçuş
telemetrisi (0), joystick (38. bayt `70H`, 39–42 yön/yükseliş hızı), 3–42. baytların XOR'u, `F0`. Kamera komuttaki değişimi
algıladığı için her komut 4 çerçeve gönderilir, ardından alanlar sıfırlanır. Kamera 20 ms'de bir 64 baytlık durum çerçevesi
(`FC 2C …`) yollar; 3. bayt `FF` ise çerçeve bir JSON yanıtıdır. Sınamalar belgedeki örnek çerçeveleri bayt bayt doğrular.

Belgede açık olmayan, gerçek kamerada denenmesi gereken noktalar:

- Videoda nokta seçerken dikey eksenin yönü (ters ise **Hedef seçerken dikey ekseni ters çevir**).
- Joystick'te yükselişin işareti (yukarı = artı varsayıldı).
- Kameranın yanıtı gönderen porta mı yoksa sabit 7001'e mi yolladığı (varsayılan yerel port 7001 ikisini de karşılar).
- Seri port (UART) üzerinden kontrol desteklenmez; yalnızca ağ (UDP).

## Skydroid

Skydroid protokol belgesini yayımlamıyor; komutlar resmî Android SDK'sındaki (RCSDK v1.9.2) karşılıklardan alındı ve
SDK belgesindeki örnek çerçevelerle sınandı. Çerçeve: `#TP` + kaynak `U` + hedef (`G` gimbal, `D` kamera) + veri uzunluğu +
`w`/`r` + 3 harfli komut + veri + sağlama (önceki baytların 8 bit toplamı, iki onaltılık hane). Örnek: `#TPUG2wPTZ056F`.

- Hız komutları (`GSY`/`GSP`, 0,5 °/s adım) joystick basılıyken 50 ms'de bir tazelenir; bırakınca hız 0 ve `PTZ00` gider.
- Konum bildirimi (`GAA`/`GAC`) 10 Hz açık tutulur.
- Bazı aygıt yazılımlarında yön ekseni terstir (**Yön eksenini ters çevir**) ve açıya gitme (`GAY`/`GAP`) yok sayılır.
- IP değiştirme, fabrika ayarı ve kalibrasyon komutları panele konmadı (cihazı erişilmez kılabilir); **Özel komut** kutusundan gönderilebilir.
- Lazer mesafe ve kart değerleri ham gösterilir (birimleri belgelenmemiş).
- C13/C20 yapay zekâ takibi için ağ komutu bulunamadı; panelde yoktur.
- C20 kamera protokolü (yakınlaştırma, odak, fotoğraf, kayıt) yalnızca SDK'dan çıkarıldı; donanımda sınanmadı.

## Yeni model eklemek

1. `src/models/<model>.js`: tanım (varsayılanlar, form alanları, panel bölümleri, durum alanları, Türkçe/İngilizce metinler).
2. `src/models/<model>.driver.js`: `CameraDriver`'dan türeyen sürücü (`exec`, `hold`, `onMessage`).
3. `src/models/defs.js` ve `src/models/index.js` listelerine, `index.html` ile `viewer.html` içindeki `<script>` listesine ekleyin.
4. `test/camera.test.js` her modelin komutlarının sürücüde ve sözlükte karşılığı olduğunu kendiliğinden sınar.
