#!/usr/bin/env bash
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_USER="$(whoami)"
PYTHON_BIN="$(which python3)"

if [ -f "$APP_DIR/venv/bin/python" ]; then
    PYTHON_BIN="$APP_DIR/venv/bin/python"
elif [ -f "$APP_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$APP_DIR/.venv/bin/python"
fi

echo "============================================================"
echo " INTERCO GCS - NVIDIA JETSON SYSTEMD SERVIS KURULUMU"
echo "============================================================"
echo " Dizin      : $APP_DIR"
echo " Kullanici  : $CURRENT_USER"
echo " Python     : $PYTHON_BIN"
echo "============================================================"

sudo usermod -a -G dialout,video,render "$CURRENT_USER" 2>/dev/null || true

SERVICE_FILE="/etc/systemd/system/interco.service"
sudo bash -c "cat > $SERVICE_FILE" <<EOF
[Unit]
Description=INTERCO Autonomous Interceptor GCS Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$APP_DIR
Environment="PYTHONUNBUFFERED=1"
Environment="INTERCO_HEADLESS=1"
Environment="DISPLAY=:0"
ExecStart=$PYTHON_BIN $APP_DIR/main.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if command -v ufw >/dev/null 2>&1; then
    if sudo ufw status | grep -q "Status: active"; then
        sudo ufw allow 8005/tcp
        sudo ufw allow 14550/udp
        sudo ufw allow 7001:7005/udp
    fi
fi

AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/interco-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=INTERCO GCS Kiosk
Exec=bash -c "sleep 4 && chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run --touch-events=enabled http://localhost:8005"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF

sudo systemctl daemon-reload
sudo systemctl enable interco.service
sudo systemctl restart interco.service

sleep 2
JETSON_IPS=$(hostname -I | xargs)

echo ""
echo "[OK] INTERCO servisi basariyla kuruldu ve baslatildi!"
echo "------------------------------------------------------------"
echo " Yerel 7 inc Ekran Adresi : http://localhost:8005"
for ip in $JETSON_IPS; do
    echo " Ag Uzerinden Erisim      : http://$ip:8005"
done
echo "------------------------------------------------------------"
echo " Servis Durumu : sudo systemctl status interco"
echo " Canli Loglar  : journalctl -u interco -f"
echo "============================================================"
