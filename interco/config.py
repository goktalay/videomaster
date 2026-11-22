# config.py
import os
import json

SETTINGS_FILE = "settings.json"

DEFAULT_SETTINGS = {
    "telemetry_protocol": "SITL",
    "telemetry_host": "127.0.0.1",
    "telemetry_port": 5760,
    "taisync_udp_in": "sitl:internal:sim",
    "web_host": "0.0.0.0",
    "web_port": 8005,
    "video_base_dir": "video",
    "bing_maps_key": "",
    "cesium_ion_token": "",
    "camera_tilt_deg": 30.0,
    "camera_vfov_deg": 60.0,
    "camera_hfov_deg": 80.0,
    "cpdd_ip": "192.168.144.108",
    "cpdd_udp_port": 9554,
    "cpdd_local_port": 7002,
    "cpdd_rtsp_url": "rtsp://192.168.144.108/live/0",
    "cam_switch_channel": 8,
    "cam_pwm_wide": 1100,
    "cam_pwm_narrow": 1500,
    "cam_pwm_thermal": 1900,
    "cameras": {
        "WIDE": {"name": "EO-WIDE (GENIS)", "url": "rtsp://192.168.144.108/live/0"},
        "NARROW": {"name": "EO-NARROW (DAR/ZOOM)", "url": "rtsp://192.168.144.108/live/0"},
        "THERMAL": {"name": "IR-THERMAL (TERMAL)", "url": "rtsp://192.168.144.108/live/0"},
        "WEBCAM": {"name": "DATASET / WEBCAM (TEST)", "url": "dataset:video01"}
    },
    "yolo_model": "yolov8n.engine" if os.path.exists("yolov8n.engine") else "yolov8n.pt",
    "yolo_imgsz": 416,
    "ai_frame_skip": 1,
    "stream_jpeg_quality": 68,
    "confidence_threshold": 0.45,
    "target_classes": "0, 2, 3, 4, 5, 7, 14",
    "intercept_pitch_max": -45.0,
    "intercept_thrust_max": 1.0,
    "yaw_rate_gain": 1.8,
    "pitch_rate_gain": 1.5
}

class ConfigManager:
    def __init__(self):
        self.data = {}
        self.load()

    def load(self):
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    self.data = json.load(f)
            except Exception:
                self.data = DEFAULT_SETTINGS.copy()
        else:
            self.data = DEFAULT_SETTINGS.copy()
            self.save(self.data)

        for k, v in DEFAULT_SETTINGS.items():
            if k not in self.data:
                self.data[k] = v.copy() if isinstance(v, dict) else v

        if "WEBCAM" not in self.data["cameras"]:
            self.data["cameras"]["WEBCAM"] = {"name": "DATASET / WEBCAM (TEST)", "url": "dataset:video01"}
            self.save(self.data)

        return self.data

    def get_mavlink_connection_string(self):
        proto = str(self.data.get("telemetry_protocol", "UDP")).upper().strip()
        host = str(self.data.get("telemetry_host", "0.0.0.0")).strip()
        port = int(self.data.get("telemetry_port", 14550))

        if proto == "SITL":
            return "sitl:internal:sim"
        elif proto == "TCP":
            target_ip = "127.0.0.1" if host in ["0.0.0.0", ""] else host
            return f"tcp:{target_ip}:{port}"
        elif proto == "TCPIN":
            listen_ip = "0.0.0.0" if host == "" else host
            return f"tcpin:{listen_ip}:{port}"
        else:
            listen_ip = "0.0.0.0" if host == "" else host
            return f"udpin:{listen_ip}:{port}"

    def save(self, new_data: dict):
        self.data.update(new_data)
        self.data["taisync_udp_in"] = self.get_mavlink_connection_string()
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=4, ensure_ascii=False)
        return self.data

    def get_target_classes_list(self):
        raw = str(self.data.get("target_classes", "0, 2, 3, 4, 5, 7, 14"))
        result = []
        for item in raw.split(","):
            item = item.strip()
            if item.isdigit():
                result.append(int(item))
        return result if result else None

cfg = ConfigManager()
