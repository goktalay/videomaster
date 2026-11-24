# Video Master

Windows için ağ video akışı görüntüleyici, çözümleyici ve kaydedici. RTSP, RTP, UDP (MPEG-TS), SRT, RTMP, HTTP/HLS ve TCP akışlarına bağlanır; videoyu oynatır, akan baytları HEX / ASCII olarak gösterir, paketleri çözümler, veri hızını grafikte çizer ve akışı dosyaya kaydeder. Mastertool ailesinin ([SSH Master](https://github.com/goktalay/sshmasters), [FTP Masters](https://github.com/goktalay/ftpmasters), SQL Master, Notepad Master, [Convert Master](https://github.com/goktalay/convertmaster)) ortak arayüz yapısı ve hesabıyla.

![Ana ekran: kart üstünde oynatma](docs/screenshots/01-ana-ekran-gece.png)

![Akış penceresi: video, HEX, veri hızı grafiği, akış ayarları, kayıt](docs/screenshots/04-akis-penceresi-gece.png)

Diğer görüntüler: [yeni bağlantı](docs/screenshots/02-yeni-baglanti-gunduz.png) · [ağ ayarları](docs/screenshots/03-ag-ayarlari-gece.png) · [paket listesi](docs/screenshots/05-paketler-gece.png) · [RTSP sinyalleşmesi](docs/screenshots/06-rtsp-sinyallesme-gunduz.png)

## İndirme

Derlenmiş exe'ler [Releases](https://github.com/goktalay/videomaster/releases) sayfasındadır:

- `Video-Master-Setup-x.y.z.exe` — kurulum (varsayılan klasör `C:\Program Files\Mastertool\Video Master`, Başlat menüsü › Master Tool › Video Master)
- `Video-Master-Portable-x.y.z.exe` — kurulumsuz, tek dosya

## Özellikler

- **Ana ekran:** bağlantı kartları — her kartın üstünde **oynat düğmesi**; basınca video o kartın üstünde oynar (CANLI rozeti, anlık veri hızı, kayıt sürerken REC). Karta **çift tıklayınca** akış penceresi açılır. Klasörler (sürükle-bırak, iç içe), arama (Ctrl+F), sağ üstte Mastertool düğmesi. Oynatılmayan kartta son görüntü soluk olarak durur.
- **Yeni (Ctrl+N) — bağlantı kaydı:** ad → protokol → o protokolün gerektirdiği tüm parametreler. Adres yapıştırılırsa (`rtsp://kullanıcı:şifre@sunucu:554/yol`) alanlar kendiliğinden dolar. **Bağlantıyı sına** düğmesi kaydetmeden bağlanır; kodek, çözünürlük ve bir kare gösterir.
  - *Bağlantı:* sunucu, port, yol, kullanıcı adı, şifre, TLS (rtsps / rtmps / https), SDP metni ya da dosyası, özel adres, açılışta oynat, notlar.
  - *Ağ:* RTSP taşıma (TCP / UDP / çok noktaya yayın / HTTP tüneli), alınacak ortamlar, yerel UDP port aralığı, kaynak adresi süzgeci; çok noktaya yayın grubu, yerel arayüz, kaynak süzgeci (SSM); SRT kipi (arayan / dinleyen / buluşma), gecikme, parola, AES anahtar boyu, streamid; RTMP akış türü; User-Agent, ek HTTP başlıkları, vekil sunucu, sertifika doğrulama; zaman aşımı, takılma süresi, soket tamponu, yeniden sıralama kuyruğu, en çok gecikme; yeniden bağlanma (bekleme, deneme sayısı).
  - *RTP / SDP:* görüntü ve ses kodeği, yük türü (PT), saat hızı, fmtp, ses portu ve kanal sayısı ya da elle SDP.
  - *Görüntü:* kapsayıcı biçimi, donanım hızlandırma (bilgisayarda olanlar), iş parçacığı, düşük gecikme, çözümleme boyutu ve süresi, akış seçimi, çözünürlük, kare hızı sınırı, kalite, yerleştirme, döndürme, çevirme, tarama giderme, bozuk paketleri atma, sistem saatiyle zaman damgası, ek ffmpeg seçenekleri.
  - *Ses* (akış seçimi, düzey, sessiz başlat), *Akış verisi* (veri kaynağı, tampon boyutu), *Kayıt* (biçim, ses, bölme, dosya adı kalıbı).
- **Akış penceresi** (karta çift tıklayınca ayrı pencere):
  - Üstte **video**; çift tık ya da F ile tam ekran. Üst çubukta Oynat / Durdur, **Kaydet**, Görüntü al, ses düzeyi.
  - **Sağda açılır kapanır "Akış ayarları" paneli:** kayıttaki tüm ayarlar; **Uygula** deyince akış yeni ayarlarla yeniden bağlanır.
  - **Altta akış verisi:** canlı akan baytlar **HEX, ASCII, ikili, ondalık, Base64** kiplerinde; satır başına 8 / 16 / 24 / 32 bayt. **Duraklat** tamponun tamamında gezdirir; kopyala, `.bin` olarak kaydet, temizle. **Paketler** sekmesi her paketi listeler (zaman, yön, tür, boyut; RTP'de PT, sıra numarası, zaman damgası, işaret biti, H.264 / H.265 NAL türü — IDR'ler vurgulu); pakete tıklayınca baytları açılır. **Sinyalleşme** sekmesi RTSP isteklerini ve yanıtlarını gösterir.
  - **Yanında akış bilgisi:** kodek ve profil, çözünürlük, en-boy oranı, kare hızı, piksel biçimi, renk, tarama, bit hızı, anahtar kare aralığı; ses kodeği, örnekleme hızı, kanallar; kapsayıcı, programlar, sunucu; RTP (SSRC, kayıp, sırasız, jitter); MPEG-TS (PID'ler, süreklilik hataları); SDP ve çalışan ffmpeg komutu.
  - **Veri hızı grafiği:** akan verinin boyutu çizgi grafikte (30 sn / 1 dk / 5 dk, bit/s ya da B/s); üzerine gelince o anın değeri.
- **Kayıt:** Kaydet'e basınca başlar, durdurunca video dosyası oluşur (MP4, MKV, MPEG-TS, MOV). Yeniden kodlanmaz (görüntü olduğu gibi yazılır; MP4'e sığmayan ses — ör. kameraların G.711'i — AAC'ye çevrilir). İsteğe bağlı dakikalık bölme. Akış penceresi kapatılsa da kayıt kartta sürer. Dosyalar `Videolar\Video Master\<bağlantı adı>\` altına yazılır (Ayarlar'dan değiştirilir). Bağlantı koparsa kayıt yeni dosyayla kendiliğinden sürer.
- **Dayanıklılık:** bağlantı koptuğunda ya da veri akışı durduğunda kendiliğinden yeniden bağlanır; hata nedeni (kimlik, zaman aşımı, reddedildi, akış yok…) kartta ve pencerede yazar.
- **Mastertool hesabı:** uygulama Mastertool hesabıyla açılır; "Beni hatırla" (Windows DPAPI), çevrimdışı çalışma, kayıt / şifremi unuttum / hesabım sayfaları.
- **Ortak oturum (tek giriş):** herhangi bir Mastertool uygulamasında giriş yapıldıysa Video Master şifre sormadan açılır; birinde çıkış yapılınca hepsinde çıkış yapılır.
- **Uçtan uca şifreli senkron:** bağlantı tanımları (kimlik bilgileri dahil), klasörler ve genel ayarlar AES-256-GCM ile şifrelenip hesaba yedeklenir; anahtar şifrenizden cihazda türetilir, sunucu içeriği okuyamaz. Kayıt dosyaları ve pencere düzeni her cihazda ayrı kalır.
- Gece / Gündüz / Sistem teması; 8 dil: Türkçe, English, Français, Deutsch, Español, العربية (sağdan sola), 中文, Русский; Windows oturumuyla başlatma ve sistem tepsisi; yeni sürüm bildirimi.

Kısayollar (akış penceresi): Space oynat / durdur · R kayıt · S görüntü al · M ses · F tam ekran · H akış verisi paneli · P ayar paneli.

## Kamera modelleri ve kontrol

RTSP bağlantısında bir **kamera modeli** seçilirse modele özel ayarlar istenir ve akış penceresinde **Kamera kontrol**
paneli açılır (joystick, takip, yakınlaştırma, kayıt, termal palet, lazer mesafe, cihaz komutları, durum bilgisi).
Desteklenen modeller: **CPDD075CCT**, **Skydroid C10 / C10 Pro, C12, C13, C20**. Ayrıntı, kaynaklar ve yeni model ekleme:
[docs/kamera-modelleri.md](docs/kamera-modelleri.md).

## Dronlar ve uçuşlar

Ana ekran **Kameralar**, **Dronlar** ve **Uçuşlar** bölümlerine ayrılır. Dronlar bölümünde uçuş kontrolcüsüne seri port, TCP,
UDP ya da UDPIN ile bağlanılır (ArduPilot, PX4, SITL): parametre ağacı (Türkçe açıklamalarla), motor testi, kalibrasyonlar,
telemetri grafikleri ve aranabilir haberleşme günlüğü. Uçuşlar bölümünde dron ve kamera birlikte izlenir: 3B harita, kamera
yerleşimleri ve HUD. Ayrıntı: [docs/dronlar-ve-ucuslar.md](docs/dronlar-ve-ucuslar.md).

## Yapay görü

Akış penceresindeki **Yapay görü** panelinde poz, insan, çoklu insan, yazı okuma (OCR), plaka, araç, hava aracı, hayvan ve nesne
tanıma modülleri ayrı ayrı ya da birlikte çalıştırılır; her modülün kendi hassasiyet ayarı vardır. Modeller kurulumla gelmez,
ilk kullanımdan önce indirilir; kendi ONNX modelinizi ekleyebilir, ayarları dosyaya kaydedip başka kameralara uygulayabilirsiniz.
Ayrıntı: [docs/yapay-goru.md](docs/yapay-goru.md).

## Protokoller

| Protokol | Adres | Akış verisinde görünen |
|---|---|---|
| RTSP / RTSPS | `rtsp://sunucu:554/yol` | Ağdaki gerçek baytlar: RTSP iletileri ve (TCP taşımada) RTP / RTCP paketleri |
| RTP | port (+ çok noktaya yayın grubu), kodek bilgisi | Ağdaki gerçek RTP datagramları |
| UDP | port (+ grup) — MPEG-TS | Ağdaki gerçek datagramlar, TS paket sayımı |
| TCP | `sunucu:port` ya da dinleme | Bağlanırken ağ baytları; dinlerken MPEG-TS kopyası |
| SDP | SDP metni / dosyası | Ağdaki gerçek RTP datagramları |
| SRT | `srt://sunucu:port` | Çözümlenmiş akışın MPEG-TS kopyası |
| RTMP / RTMPS | `rtmp://sunucu/uygulama/anahtar` | Çözümlenmiş akışın MPEG-TS kopyası |
| HTTP / HLS | `http(s)://…/a.m3u8`, MJPEG, HTTP-TS | Çözümlenmiş akışın MPEG-TS kopyası |
| Özel adres | ffmpeg'in açabildiği her adres | Çözümlenmiş akışın MPEG-TS kopyası |

## Nasıl çalışır

- Akışları **FFmpeg** açar ([ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), ayrı program olarak). Görüntü JPEG karelere, ses PCM'e çevrilip pencereye aktarılır; bu sayede H.264, H.265, MPEG-2/4, MJPEG, VP8/9, AV1 ve FFmpeg'in çözdüğü her kodek oynar.
- **Ağdaki gerçek baytları** gösterebilmek için uygulama kaynak ile FFmpeg arasına yerel bir aktarıcı koyar: UDP / RTP datagramlarını kendisi alıp `127.0.0.1`'e çoğaltır; RTSP ve TCP'de yerel bir porttan kaynağa köprü kurar (RTSPS'te TLS'i uygulama açar). "Akış verisi › Veri kaynağı" *çözümlenmiş akış* yapılırsa kaynağa doğrudan bağlanılır.
- **Kayıt** kaynağa ikinci bir bağlantıyla yapılır; böylece görüntü kesilmeden başlar ve durur. UDP / RTP'de ikinci bağlantı gerekmez (datagramlar çoğaltılır).
- Kartta oynatma küçük çözünürlük ve 8 kare/sn ile yapılır; akış penceresi açılınca tam çözünürlüğe ve sese geçilir.

## Veriler

`%APPDATA%\Video Master\`:

- `store.json` — bağlantılar (şifreler DPAPI ile şifreli), klasörler, ayarlar; `local` bölümünde cihaza özgü son akış bilgisi
- `account.json` — oturum (DPAPI ile şifreli)
- `thumbs\` — kart küçük resimleri; `tmp\` — geçici SDP dosyaları

Kayıtlar ve anlık görüntüler: `%USERPROFILE%\Videos\Video Master\<bağlantı adı>\`.

## Geliştirme

```bash
npm install
```

```bash
npm start
```

Sahte hesap sunucusuyla (test@example.com / Test1234!):

```bash
node test/mock-server.js 8787
```

```bash
VDM_API=http://127.0.0.1:8787 npm start
```

Testler — şema, komut üretimi, yakalayıcı, senkron, ortak oturum ve gerçek FFmpeg ile uçtan uca akış (UDP MPEG-TS, ham RTP, kimlik doğrulamalı RTSP, kayıt, yeniden bağlanma; RTSP için `test/rtsp-server.js` içindeki küçük sunucu kullanılır):

```bash
npm test
```

Ortam değişkenleri: `VDM_API` (hesap sunucusu), `VDM_FFMPEG` (başka bir ffmpeg). Linux'ta ffmpeg-static'in tümleşik derlemesi UDP girişinde çöktüğü için testler sistem ffmpeg'iyle çalıştırılır: `VDM_FFMPEG=/usr/bin/ffmpeg npm test`.

Yeni bir akış ayarı eklemek için `src/schema.js` içindeki `FIELDS` listesine bir satır, `src/stream/args.js`'e karşılık gelen ffmpeg seçeneği ve `src/i18n/tr.js` + `en.js`'e `f.<anahtar>` etiketi eklenir; kayıt formu ve akış penceresindeki panel kendiliğinden güncellenir.

### Mastertool sunucusu

Hesap uçları `src/account.js` başındaki sabitlerdedir: `APP_API = '/api/vm'`, `APP_CODE = 'vm'`, şifreleme bilgisi `ENC_INFO = 'vdm-enc-v1'`, adres `mastertool.download` (Video Master'ın kendi sitesi yok; tanıtım sayfası `mastertool.download/video-master`). Sunucu tarafı `goktalay/hepgo` › `central/sshmaster_server` içinde `TOOLS['vm']` kaydıdır.

## Exe derleme

```bash
npm run dist
```

İkonu değiştirmek için `build/icon.svg` dosyasını düzenleyip `npm run icon` çalıştırın.

Tanıtım ekran görüntüleri (`docs/screenshots`, Türkçe + `en/`, gece ve gündüz; sınama akışlarıyla, Linux'ta xvfb altında):

```bash
VDM_FFMPEG=/usr/bin/ffmpeg xvfb-run -a -s "-screen 0 1920x1200x24" npm run screenshots
```

## Sürüm yayınlama

Yeni sürüm için bir etiket göndermek yeterli; GitHub Actions testleri çalıştırır, exe'leri derleyip Release'e ekler:

```bash
git tag v1.0.0
```

```bash
git push origin v1.0.0
```

Sürüm numarası etiketten alınır. Etiketle yayınlanan sürüm ayrıca mastertool.download'a yüklenir (`scripts/upload-videomaster.sh`; depo secret'ı `VIDEOM_RELEASE_KEY`, tanımlı değilse adım atlanır).

## Lisanslar ve üçüncü taraf bileşenler

Video Master MIT lisanslıdır. Birlikte dağıtılan bileşenler:

- **FFmpeg** — ffmpeg-static üzerinden gelen derleme **GPL** lisanslıdır. FFmpeg ayrı bir program olarak çalıştırılır; kaynak kodu https://ffmpeg.org adresindedir. Dağıtımda FFmpeg lisansına (GPL v3) uyulmalıdır.
- **@napi-rs/keyring** — MIT (Windows Kimlik Bilgisi Yöneticisi erişimi, ortak oturum).
- **Electron / Chromium** — MIT ve Chromium lisansları.

## Bilinen sınırlar

- Görüntü pencereye JPEG kareler olarak aktarılır; 4K ve yüksek kare hızlı akışlarda işlemci kullanımı yüksektir ("Görüntü çözünürlüğü" ve "Kare hızı sınırı" ile düşürülür). Ses ile görüntü arasında küçük bir kayma olabilir.
- RTSP'de UDP taşıma seçilirse RTP paketleri akış verisinde tek tek görünmez (yalnız sinyalleşme ve çözümlenmiş akışın kopyası).
- Kayıt kaynağa ikinci bir oturum açar; yalnız tek istemciye izin veren cihazlarda kayıt başlamayabilir.
- SRT, RTMP ve HLS'te ağdaki ham baytlar yerine çözümlenmiş akışın MPEG-TS kopyası gösterilir.
