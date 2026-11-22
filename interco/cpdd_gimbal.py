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

    def send_json_cmd(self, cmd_dict: dict):
        raw = json.dumps(cmd_dict, separators=(",", ":")).encode("utf-8")
        self.send_raw_bytes(raw, wait_reply=False)

    def send_custom_hex(self, type_b_hex: str, type_cd_hex: str):
        try:
            b_val = int(type_b_hex, 16) & 0xFF
            cd_bytes = bytes.fromhex(type_cd_hex.replace(" ", ""))
            if len(cd_bytes) < 4:
                cd_bytes = cd_bytes.ljust(4, b"\x00")
            cd4 = cd_bytes[:4]

            f1_body = bytes([0x07, b_val]) + cd4
            xor_cs = 0
            for byte in f1_body:
                xor_cs ^= byte
            pkt1 = bytes([0x55, 0xAA, 0xDC]) + f1_body + bytes([xor_cs & 0xFF])
            self.send_raw_bytes(pkt1)

            f2_body = bytes([0x06, b_val]) + cd4
            sum_cs = sum(f2_body) & 0xFF
            pkt2 = bytes([0xEB, 0x90]) + f2_body + bytes([sum_cs])
            self.send_raw_bytes(pkt2)

            return True
        except Exception:
            return False

    def switch_view(self, mode: str):
        mode_u = mode.upper().strip()
        self.current_view = mode_u

        if mode_u == "WIDE":
            self.zoom_level = 1.0
            self.send_custom_hex("2F", "01 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 0})
            self.last_status = "NET UDP -> GENİŞ (VISIBLE-1)"

        elif mode_u == "NARROW":
            self.zoom_level = 4.0
            self.send_custom_hex("2F", "02 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 2})
            self.last_status = "NET UDP -> DAR (TELE)"

        elif mode_u == "THERMAL":
            self.send_custom_hex("2F", "03 00 00 00")
            self.send_json_cmd({"cmd": "set_view", "mode": 1})
            self.last_status = "NET UDP -> TERMAL (IR)"

        elif mode_u == "FUSION":
            self.send_custom_hex("2F", "04 00 00 00")
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
