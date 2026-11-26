# INTERCO // CPDD075 + 7" Dokunmatik & NVIDIA Jetson Yer Kontrol İstasyonu

## Kurulum & Çalıştırma

### 1. Gerekli Paketler
```bash
pip install -r requirements.txt
```

### 2. CPDD075 Kamera Ağ Ayarı
Kamera varsayılan IP adresi `192.168.144.108` (RTSP: `rtsp://192.168.144.108/live/0`, UDP Kontrol: `9554`, Local Port: `7002`)'dir. Jetson Ethernet arayüzü `192.168.144.x` alt ağında olmalıdır.

### 3. NVIDIA Jetson Sistem Servisi Olarak Kurulum
```bash
chmod +x install_jetson_service.sh
./install_jetson_service.sh
```
Kurulum tamamlandığında arayüz yerel 7" ekranda (`http://localhost:8005`) ve ağ üzerinden (`http://<JETSON_IP>:8005`) erişilebilir olur.
