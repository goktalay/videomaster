# cpdd_gimbal.py
# CPDD075 AI Recognition and Tracking Kit - Saf Network (UDP 9554) Kontrol Sürücüsü

import json
import socket
import threading
import time
from config import cfg

class CPDD075Controller:
    def __init__(self):
        self.sock = None
        self.lock = threading.Lock()
        self.current_view = "WIDE"
        self.ir_palette_idx = 0
        self.zoom_level = 1.0
        self.bound_local_port = 7002
        self.last_status = "NETWORK UDP HAZIR"
        self.last_response = ""
        self._init_socket()

    def _init_socket(self):
        with self.lock:
            if self.sock:
                try:
                    self.sock.close()
                except Exception:
                    pass
                self.sock = None
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.settimeout(0.35)
                pref_port = int(cfg.data.get("cpdd_local_port", 7002))
                bound = False
                for cand_port in [pref_port, 7002, 7003, 7001]:
                    try:
                        s.bind(("0.0.0.0", cand_port))
                        self.bound_local_port = cand_port
                        bound = True
                        break
                    except Exception:
                        continue
                if not bound:
                    s.bind(("0.0.0.0", 0))
                    self.bound_local_port = s.getsockname()[1]
                self.sock = s
                self.last_status = f"UDP LOCAL:{self.bound_local_port} -> 9554"
            except Exception as e:
                self.last_status = f"SOCK ERR: {e}"

    def reload(self):
        self._init_socket()

    def _get_target(self):
        ip = str(cfg.data.get("cpdd_ip", "192.168.144.108")).strip() or "192.168.144.108"
        port = int(cfg.data.get("cpdd_udp_port", 9554))
        return (ip, port)

    def send_raw_bytes(self, payload: bytes, wait_reply: bool = False) -> str:
        if not self.sock:
            self._init_socket()
        target = self._get_target()
        try:
            with self.lock:
                self.sock.sendto(payload, target)
                if wait_reply:
                    try:
                        data, _ = self.sock.recvfrom(2048)
                        reply = data.decode("utf-8", errors="replace").strip()
                        self.last_response = reply
                        return reply
                    except socket.timeout:
                        return ""
            return "OK"
        except Exception as e:
            self.last_status = f"TX ERR: {e}"
            return ""

    def send_text_cmd(self, text_cmd: str, wait_reply: bool = True) -> str:
        return self.send_raw_bytes(text_cmd.strip().encode("utf-8"), wait_reply=wait_reply)

    def _build_44byte_frame(self, cmd_byte: int, param_c: bytes = b"", param_d: bytes = b"",
                            telemetry: bytes = b"", joystick_cmd: int = 0,
                            joystick_params: bytes = b"") -> bytes:
        """Seri Protokol V2.14 - 44 byte sabit çerçeve oluşturur.

        Çerçeve yapısı (Table 1):
          Byte  1-2:  Senkronizasyon kodu (FB 2C)
          Byte  3:    Standart komut kodu (B)
          Byte  4-5:  Parametre C (2 byte)
          Byte  6-7:  Parametre D (2 byte)
          Byte  8-37: Uçuş kontrol telemetri (E, 30 byte)
          Byte  38:   Gimbal joystick komut kodu (F)
          Byte  39-42: Gimbal joystick parametreleri (G + H, 4 byte)
          Byte  43:   Kontrol byte (I) - byte 3..42 XOR
          Byte  44:   Çerçeve sonu (J) = F0
        """
        # B: komut kodu (1 byte)
        b = cmd_byte & 0xFF
        # C: parametre 1-2 (2 byte)
        c = (param_c + b"\x00\x00")[:2]
        # D: parametre 2 (2 byte)
        d = (param_d + b"\x00\x00")[:2]
        # E: telemetri (30 byte)
        e = (telemetry + b"\x00" * 30)[:30]
        # F: joystick komut (1 byte)
        f = joystick_cmd & 0xFF
        # G+H: joystick parametreleri (4 byte)
        gh = (joystick_params + b"\x00\x00\x00\x00")[:4]

        payload = bytes([b]) + c + d + e + bytes([f]) + gh  # byte 3..42 (40 byte)
        xor_cs = 0
        for byte_val in payload:
            xor_cs ^= byte_val
        return bytes([0xFB, 0x2C]) + payload + bytes([xor_cs & 0xFF, 0xF0])

    def send_command(self, cmd_hex: str, param_c_hex: str = "00 00",
                     param_d_hex: str = "00 00") -> bool:
        """44-byte protokol çerçevesiyle komut gönderir."""
        try:
            cmd_byte = int(cmd_hex, 16) & 0xFF
            c_bytes = bytes.fromhex(param_c_hex.replace(" ", ""))
            d_bytes = bytes.fromhex(param_d_hex.replace(" ", ""))
            frame = self._build_44byte_frame(cmd_byte, c_bytes, d_bytes)
            self.send_raw_bytes(frame)
            return True
        except Exception:
            return False

    def send_json_cmd(self, cmd_dict: dict):
        """JSON komutu 44-byte çerçeve içinde gönderir (komut kodu 0x90)."""
        json_bytes = json.dumps(cmd_dict, separators=(",", ":")).encode("utf-8")
        json_len = len(json_bytes)
        # Parametre C: JSON uzunluğu (2 byte, little-endian)
        param_c = bytes([json_len & 0xFF, (json_len >> 8) & 0xFF])
        # JSON verisi telemetri alanına (30 byte) yerleştirilir
        telemetry = (json_bytes + b"\x00" * 30)[:30]
        frame = self._build_44byte_frame(0x90, param_c, b"\x00\x00", telemetry)
        self.send_raw_bytes(frame)
        # Yedek olarak ham JSON de gönder (SDK UDP uyumluluğu)
        self.send_raw_bytes(json_bytes, wait_reply=False)

    def send_custom_hex(self, type_b_hex: str, type_cd_hex: str):
        """Geriye uyumluluk: eski çağrıları 44-byte çerçeveye yönlendirir."""
        try:
            cd_bytes = bytes.fromhex(type_cd_hex.replace(" ", ""))
            if len(cd_bytes) < 4:
                cd_bytes = cd_bytes.ljust(4, b"\x00")
            param_c = cd_bytes[:2]
            param_d = cd_bytes[2:4]
            return self.send_command(type_b_hex, param_c.hex(), param_d.hex())
        except Exception:
            return False

    def switch_view(self, mode: str):
        """Kamera görüntü kaynağını değiştirir.

        Seri Protokol V2.14 - Komut 0x25 (Video display mode settings):
            param 0x00 = Kızılötesi video 1  (THERMAL)
            param 0x01 = Görünür ışık video 1 (WIDE)
            param 0x02 = Görünür ışık video 2 (NARROW / tele)
            param 0x03 = Kızılötesi video 2   (FUSION / EO+IR)
        """
        mode_u = mode.upper().strip()
        self.current_view = mode_u

        if mode_u == "WIDE":
            self.zoom_level = 1.0
            self.send_custom_hex("25", "01 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 1})
            self.last_status = "NET UDP -> GENİŞ (VISIBLE-1)"

        elif mode_u == "NARROW":
            self.zoom_level = 4.0
            self.send_custom_hex("25", "02 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 2})
            self.last_status = "NET UDP -> DAR (TELE)"

        elif mode_u == "THERMAL":
            self.send_custom_hex("25", "00 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 0})
            self.last_status = "NET UDP -> TERMAL (IR)"

        elif mode_u == "FUSION":
            self.send_custom_hex("25", "03 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 3})
            self.last_status = "NET UDP -> EO+IR (FUSION)"

    def zoom_step(self, direction: int):
        if direction > 0:
            self.zoom_level = min(16.0, round(self.zoom_level + 1.0, 1))
            self.send_custom_hex("45", "01 00 00 00")
        elif direction < 0:
            self.zoom_level = max(1.0, round(self.zoom_level - 1.0, 1))
            self.send_custom_hex("45", "02 00 00 00")
        else:
            self.send_custom_hex("45", "00 00 00 00")

    def switch_ir_palette(self):
        self.ir_palette_idx = (self.ir_palette_idx + 1) % 10
        self.send_custom_hex("25", f"{self.ir_palette_idx:02X} 00 00 00")

    def gimbal_center(self):
        self.send_custom_hex("23", "01 00 00 00")

    def start_hardware_track(self, norm_x: float = 0.0, norm_y: float = 0.0, target_id: int = 0):
        px_offset_x = int(norm_x * 640)
        px_offset_y = int(norm_y * 360)
        self.send_json_cmd({
            "cmd": "track_start",
            "id": int(target_id),
            "offset_x": px_offset_x,
            "offset_y": px_offset_y
        })

    def stop_hardware_track(self):
        self.send_json_cmd({"cmd": "track_stop"})

    def test_connection(self):
        ip, port = self._get_target()
        reply = self.send_text_cmd("sh:ifconfig", wait_reply=True)
        rtsp_url = cfg.data.get("cpdd_rtsp_url", f"rtsp://{ip}/live/0")
        if reply:
            return {
                "ok": True,
                "msg": f"CPDD075 NETWORK AKTİF (Local:{self.bound_local_port} -> {ip}:{port}) | YANIT: {reply[:60]}"
            }
        return {
            "ok": True,
            "msg": f"CPDD075 UDP PAKETİ GÖNDERİLDİ (Local:{self.bound_local_port} -> {ip}:{port}) | RTSP: {rtsp_url}"
        }

cpdd_ctrl = CPDD075Controller()
