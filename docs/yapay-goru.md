# Yapay görü

Akış penceresinin sağ panelindeki **Yapay görü** sekmesi, kameradan gelen görüntü üzerinde aşağıdaki modülleri çalıştırır.
Birden çok modül aynı anda açılabilir; her modülün kendi **hassasiyet** (%) ayarı vardır. Sonuçlar videonun üstüne çizilir
ve panelde listelenir (okunan yazı ve plakalar tıklanınca panoya kopyalanır).

| Modül | Ne yapar | Model |
|---|---|---|
| Poz | Kişilerin iskeleti (17 eklem noktası) | RTMO-t |
| İnsan tanıma | En belirgin tek kişi | YOLOX-Tiny |
| Çoklu insan tanıma | Görüntüdeki herkes, sayısıyla | YOLOX-Tiny |
| Yazı okuma (OCR) | Yatay yazı satırları; Latin alfabesi, Türkçe harfler dahil | PP-OCRv5 mobile (bulma + okuma) |
| Plaka tanıma | Plakayı bulur ve okur | YOLOv9-t plaka bulucu + CCT-XS plaka okuyucu |
| Araç tanıma | Otomobil, kamyon, otobüs, motosiklet, bisiklet, tren, tekne | YOLOX-Tiny |
| Hava aracı tanıma | Uçak, helikopter, insansız hava aracı | YOLO11n (hava aracı) |
| Hayvan tanıma | Kuş, kedi, köpek, at, koyun, inek, fil, ayı, zebra, zürafa | YOLOX-Tiny |
| Nesne tanıma | COCO'nun 80 nesne türü | YOLOX-Tiny |

İnsan, araç, hayvan ve nesne modülleri aynı modeli paylaşır: kaç tanesi açık olursa olsun model karede bir kez çalışır.

## Modeller

- Kurulum dosyasında **model yoktur**. Bir modülü açabilmek için önce modeli **İndir** düğmesiyle indirmek gerekir (toplam ≈ 82 MB).
- Modeller şu klasöre iner: taşınabilir sürümde exe'nin yanındaki `VideoMaster-models`, kurulu sürümde program klasöründeki
  `models` (yazılamıyorsa kullanıcı veri klasörü). Klasör panelde yazar; **Klasörü aç** ile açılır.
- Her dosya kendi yayın adresinden indirilir ve SHA-256 ile doğrulanır. Çalışma sırasında ağa çıkılmaz; analiz bilgisayarda yapılır.
- **Model ekle**: kendi ONNX nesne tanıma modelinizi adres (ilk kullanımdan önce indirilir) ya da dosya (klasöre kopyalanır) olarak
  ekleyebilirsiniz. Giriş boyutu, sınıf adları ve çıkış biçimi (YOLOX, YOLOv8/v9/v11, YOLOv5/v7, uçtan uca; ya da otomatik) sorulur.
  Eklenen model listede kendi hassasiyet ayarıyla ayrı bir modül olur.

| Model | Boyut | Lisans | Kaynak |
|---|---|---|---|
| YOLOX-Tiny | 20,2 MB | Apache-2.0 | Megvii-BaseDetection/YOLOX |
| RTMO-t | 27,4 MB | Apache-2.0 | OpenMMLab MMPose (namas191297/rtmo-ort yayını) |
| PP-OCRv5 mobile yazı bulma | 4,7 MB | Apache-2.0 | PaddleOCR (PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models dönüşümü) |
| PP-OCRv5 mobile Latin yazı okuma + sözlük | 8,1 MB | Apache-2.0 | PaddleOCR |
| YOLO11n hava aracı (uçak, helikopter, İHA) | 10,6 MB | AGPL-3.0 (Ultralytics YOLO11) | manako/Detect-aircraft-and-drones-detection (Hugging Face) |
| YOLOv9-t 384 plaka bulma | 7,8 MB | MIT (depo lisansı) | ankandrew/open-image-models |
| CCT-XS v2 plaka okuma | 3,3 MB | MIT | ankandrew/fast-plate-ocr |

Bilinmesi gerekenler:

- Plaka bulucunun deposu MIT lisanslıdır ama ağırlıklar için ayrı bir lisans beyanı yoktur; model YOLOv9 (GPL-3.0 kodu) ile
  eğitilmiş görünüyor. Uygulama modeli dağıtmaz, kullanıcı indirir; ticari kullanımda hukuki değerlendirme önerilir.
- OCR modelleri GitHub LFS üzerinden iner; o deponun bant genişliği kotası dolarsa indirme başarısız olabilir.
- Hava aracı modeli YOLO11 tabanlıdır; Ultralytics YOLO ağırlıkları AGPL-3.0 kapsamındadır (yayın sayfasında ayrıca lisans
  belirtilmemiş). Yayın sahibi sürüm sabitlemediği için bu dosyada SHA-256 doğrulaması yapılmaz.
- OCR dikey ya da belirgin eğik yazıyı okumaz. Plaka okuyucu Latin harfli plakalar içindir (en çok 10 hane).

## Ayarlar ve ayar dosyası

Sayısal ayarların hepsi kaydırıcıdır: saniyedeki analiz sayısı, çakışan kutuları birleştirme eşiği, karede en çok sonuç,
işlemci iş parçacığı, çizgi kalınlığı, etiket yazı boyutu. Ayarlar kameraya özeldir ve bağlantıyla birlikte saklanır.

**Ayar dosyası → Dosyaya kaydet** yapay görü ayarlarını (açık modüller, hassasiyetler, kullanılan kullanıcı modellerinin tanımları)
`.vmvision.json` dosyasına yazar. Başka bir kameranın penceresinde **Dosyadan yükle** aynı ayarları doğrudan uygular.

## Nasıl çalışır

Modeller pencere içindeki bir işçide onnxruntime-web (WebAssembly, SIMD, çok iş parçacıklı) ile çalışır; ekran kartı gerekmez.
Hız işlemciye bağlıdır: tek başına ölçümde 4 iş parçacığıyla YOLOX-Tiny ≈ 100 ms, RTMO-t ≈ 120 ms, plaka ≈ 60 ms, OCR satır
sayısına göre 0,2–1 s. Analiz hızı videonun akıcılığını etkilemez; çizimler son analiz sonucunu gösterir.
