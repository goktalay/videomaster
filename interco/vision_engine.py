import torch
from collections import deque
# vision_engine.py
import os
import re
import cv2
import time
import base64
import subprocess
import threading
import numpy as np
from ultralytics import YOLO
from config import cfg
from cpdd_gimbal import cpdd_ctrl

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
    "rtsp_transport;tcp|"
    "fflags;nobuffer+discardcorrupt|"
    "flags;low_delay|"
    "probesize;1000000|"
    "analyzeduration;1000000|"
    "stimeout;3000000"
)
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "error"
os.environ["OPENCV_VIDEOIO_PRIORITY_OBSENSOR"] = "0"
os.environ["OPENCV_VIDEOIO_PRIORITY_MSMF"] = "0"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
VIDEO_EXTS = {".mp4", ".avi", ".mkv", ".mov", ".ts", ".m4v"}

def natural_sort_key(s):
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r"([0-9]+)", s)]

def windows_has_camera() -> bool:
    if os.name != "nt":
        return True
    try:
        cmd = 'powershell -NoProfile -Command "Get-PnpDevice -Class Camera,Image -Status OK | Select-Object -ExpandProperty FriendlyName"'
        out = subprocess.check_output(cmd, shell=True, timeout=2.0, stderr=subprocess.DEVNULL).decode("utf-8", errors="ignore").strip()
        return len(out) > 0
    except Exception:
        return False

def resolve_dataset_folder(folder_name: str) -> str:
    base_dir = str(cfg.data.get("video_base_dir", "video")).strip().strip('"').strip("'")
    if not base_dir:
        base_dir = "video"

    candidates = []
    if os.path.isabs(base_dir):
        candidates.append(os.path.join(base_dir, folder_name))
    else:
        candidates.append(os.path.abspath(os.path.join(base_dir, folder_name)))
        candidates.append(os.path.abspath(os.path.join("..", base_dir, folder_name)))
        candidates.append(os.path.abspath(os.path.join("..", "..", base_dir, folder_name)))
        candidates.append(os.path.abspath(folder_name))

    for path in candidates:
        if os.path.isdir(path):
            return path
    return candidates[0]

TACTICAL_CLASS_LABELS = {
    0: "TGT-PRS",
    2: "VEH-CAR",
    3: "VEH-MOTO",
    4: "FW-UAV",
    5: "VEH-BUS",
    7: "VEH-TRK",
    14: "AIR-TGT"
}

class SequenceFolderCapture:
    def __init__(self, folder_path: str):
        self.folder_path = folder_path
        self.image_files = []
        self.video_files = []
        self.idx = 0
        self.current_video_cap = None
        self.opened = False
        self.error_msg = ""
        self._scan_folder()

    def _scan_folder(self):
        if not os.path.isdir(self.folder_path):
            self.error_msg = f"Klasor bulunamadi: {self.folder_path}"
            return

        entries = sorted(os.listdir(self.folder_path), key=natural_sort_key)
        for name in entries:
            full_path = os.path.join(self.folder_path, name)
            if not os.path.isfile(full_path):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext in IMAGE_EXTS:
                self.image_files.append(full_path)
            elif ext in VIDEO_EXTS:
                self.video_files.append(full_path)

        if self.image_files:
            self.opened = True
        elif self.video_files:
            self.current_video_cap = cv2.VideoCapture(self.video_files[0])
            self.opened = self.current_video_cap.isOpened()
            if not self.opened:
                self.error_msg = f"Video dosyasi acilamadi: {self.video_files[0]}"
        else:
            self.error_msg = f"Klasorde goruntu/video dosyasi yok (00001...): {self.folder_path}"

    def isOpened(self):
        return self.opened

    def read(self):
        if not self.opened:
            return False, None

        if self.image_files:
            if self.idx >= len(self.image_files):
                self.idx = 0
            img_path = self.image_files[self.idx]
            self.idx += 1
            frame = cv2.imread(img_path)
            if frame is None:
                return False, None
            return True, frame

        if self.video_files and self.current_video_cap is not None:
            ret, frame = self.current_video_cap.read()
            if ret and frame is not None:
                return True, frame
            self.current_video_cap.release()
            self.idx = (self.idx + 1) % len(self.video_files)
            self.current_video_cap = cv2.VideoCapture(self.video_files[self.idx])
            if self.current_video_cap.isOpened():
                return self.current_video_cap.read()
        return False, None

    def release(self):
        self.opened = False
        if self.current_video_cap is not None:
            try:
                self.current_video_cap.release()
            except Exception:
                pass
            self.current_video_cap = None

class VideoChannelStream:
    def __init__(self, channel_type: str):
        self.channel_type = channel_type
        self.frame = None
        self.ret = False
        self.status = "SINYAL YOK"
        self.error_detail = ""
        self.running = True
        self.cap = None
        self.is_looped_media = False
        self.force_reconnect = False
        self.decoder_type = "NONE"
        self.stream_fps = 0.0
        self._fps_counter = 0
        self._fps_last_t = time.time()
        threading.Thread(target=self._worker, daemon=True).start()

    def trigger_reconnect(self):
        self.force_reconnect = True

    def _get_source_url(self) -> str:
        if self.channel_type == "WEBCAM":
            return str(cfg.data.get("cameras", {}).get("WEBCAM", {}).get("url", "dataset:video01")).strip()
        rtsp = str(cfg.data.get("cpdd_rtsp_url", "")).strip()
        if not rtsp:
            ip = str(cfg.data.get("cpdd_ip", "192.168.144.108")).strip() or "192.168.144.108"
            rtsp = f"rtsp://{ip}/live/0"
        return rtsp

    def _open_capture(self, source: str):
        src_str = str(source).strip().strip('"').strip("'")
        self.is_looped_media = False
        self.error_detail = ""

        if not src_str:
            self.error_detail = "Kaynak adresi bos birakilmis."
            return None

        if src_str.lower().startswith("dataset:") or re.fullmatch(r"video\d{1,2}", src_str.lower()):
            folder_name = src_str.split(":", 1)[1].strip() if ":" in src_str else src_str
            folder_path = resolve_dataset_folder(folder_name)
            seq_cap = SequenceFolderCapture(folder_path)
            if seq_cap.isOpened():
                self.is_looped_media = True
                self.decoder_type = "DATASET"
                return seq_cap
            self.error_detail = seq_cap.error_msg
            return None

        if src_str.isdigit():
            if os.name == "nt" and not windows_has_camera():
                self.error_detail = "Sistemde fiziksel kamera bulunamadi."
                return None

            idx = int(src_str)
            try:
                cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(idx)
                if cap is not None and cap.isOpened():
                    ret, test_frame = cap.read()
                    if ret and test_frame is not None:
                        self.is_looped_media = True
                        return cap
                    cap.release()
            except Exception as e:
                self.error_detail = f"Kamera surucu hatasi: {str(e)}"
                return None

            self.error_detail = f"Kamera #{idx} acilamadi."
            return None

        if not src_str.lower().startswith(("rtsp://", "http://", "https://")):
            if os.path.isdir(src_str):
                seq_cap = SequenceFolderCapture(src_str)
                if seq_cap.isOpened():
                    self.is_looped_media = True
                    return seq_cap
                self.error_detail = seq_cap.error_msg
                return None

            if os.path.isfile(src_str):
                try:
                    cap = cv2.VideoCapture(src_str)
                    if cap is not None and cap.isOpened():
                        self.is_looped_media = True
                        return cap
                except Exception as e:
                    self.error_detail = f"Video dosyasi okunamadi: {str(e)}"
                    return None
                self.error_detail = "Video kodegi desteklenmiyor."
                return None
            else:
                self.error_detail = f"Dosya/klasor bulunamadi: {src_str}"
                return None

        try:
            gst_pipeline = (
                f"rtspsrc location={src_str} protocols=tcp latency=0 ! "
                "rtph264depay ! h264parse ! nvv4l2decoder ! "
                "nvvidconv ! video/x-raw, format=BGRx ! "
                "videoconvert ! video/x-raw, format=BGR ! appsink drop=1 sync=false"
            )
            cap = cv2.VideoCapture(gst_pipeline, cv2.CAP_GSTREAMER)
            if cap is not None and cap.isOpened():
                self.decoder_type = "NVDEC-GST"
                return cap
        except Exception:
            pass

        try:
            cap = cv2.VideoCapture(src_str, cv2.CAP_FFMPEG)
            if cap is not None and cap.isOpened():
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                self.decoder_type = "FFMPEG-CPU"
                return cap
        except Exception:
            pass

        self.error_detail = f"CPDD075 RTSP akisina ulasilamadi ({src_str})"
        return None

    def _worker(self):
        while self.running:
            try:
                url = self._get_source_url()

                if self.force_reconnect or self.cap is None or not self.cap.isOpened():
                    self.force_reconnect = False
                    self.ret = False
                    if self.cap:
                        try:
                            self.cap.release()
                        except Exception:
                            pass
                    self.status = "BAGLANIYOR"
                    self.cap = self._open_capture(url)
                    if self.cap is None or not self.cap.isOpened():
                        self.status = "NO VIDEO"
                        time.sleep(2.5)
                        continue

                ret, frame = self.cap.read()
                if ret and frame is not None:
                    self.ret = True
                    self.frame = frame
                    self.status = "ONLINE"
                    self.error_detail = ""
                    self._fps_counter += 1
                    now_f = time.time()
                    if now_f - self._fps_last_t >= 1.0:
                        self.stream_fps = round(self._fps_counter / (now_f - self._fps_last_t), 1)
                        self._fps_counter = 0
                        self._fps_last_t = now_f
                    if self.is_looped_media:
                        time.sleep(0.025)
                else:
                    if not isinstance(self.cap, SequenceFolderCapture) and self.is_looped_media and self.cap is not None:
                        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue

                    self.ret = False
                    self.status = "LOS"
                    self.error_detail = "Video akisi kesildi."
                    if self.cap:
                        self.cap.release()
                    self.cap = None
                    time.sleep(1.5)
            except Exception as e:
                self.ret = False
                self.status = "ERR"
                self.error_detail = str(e)
                self.cap = None
                time.sleep(2.0)

class VisionSystem:
    def __init__(self, mav_controller):
        self.mav = mav_controller
        self.main_stream = VideoChannelStream("MAIN")
        self.test_stream = VideoChannelStream("WEBCAM")

        self.active_cam_key = "WIDE"
        self.auto_switch_enabled = True
        self.locked_target_id = None
        self.last_locked_center = None

        self.detected_targets = []
        self.latest_annotated_jpeg = None
        self.model = None
        self.model_status = "INIT"
        self.current_model_name = ""
        self.compute_device = "GPU (CUDA)" if torch.cuda.is_available() else "CPU (NO-CUDA)"
        self.pipeline_fps = 0.0
        self.infer_ms = 0.0
        self.logs = deque(maxlen=30)
        self._loop_counter = 0
        self._loop_fps_t = time.time()
        self._frame_idx = 0
        self._last_cached_dets = []

        self.add_log(f"SISTEM BASLADI | CIHAZ: {self.compute_device}")
        if not torch.cuda.is_available():
            self.add_log("UYARI: PyTorch CPU modunda! GPU hizlandirma icin Jetson CUDA wheel gerekli.")

        self.running = True
        threading.Thread(target=self._load_model_async, daemon=True).start()
        threading.Thread(target=self._process_loop, daemon=True).start()

    def add_log(self, msg: str):
        ts = time.strftime("%H:%M:%S")
        self.logs.append(f"[{ts}] {msg}")

    def _get_active_stream(self) -> VideoChannelStream:
        if self.active_cam_key == "WEBCAM":
            return self.test_stream
        return self.main_stream

    def scan_local_webcams(self):
        if os.name == "nt" and not windows_has_camera():
            return []

        available = []
        for idx in range(3):
            w_url = str(cfg.data.get("cameras", {}).get("WEBCAM", {}).get("url", "")).strip()
            if self.test_stream.ret and w_url == str(idx):
                available.append(idx)
                continue
            try:
                cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(idx)
                if cap is not None and cap.isOpened():
                    ret, frm = cap.read()
                    cap.release()
                    if ret and frm is not None:
                        available.append(idx)
            except Exception:
                pass
        return available

    def scan_dataset_folders(self):
        report = []
        for i in range(1, 21):
            fname = f"video{i:02d}"
            fpath = resolve_dataset_folder(fname)
            exists = os.path.isdir(fpath)
            count = 0
            if exists:
                count = sum(
                    1 for f in os.listdir(fpath)
                    if os.path.splitext(f)[1].lower() in (IMAGE_EXTS | VIDEO_EXTS)
                )
            report.append({
                "name": fname,
                "exists": exists,
                "count": count,
                "path": fpath
            })
        return report

    def _load_model_async(self):
        model_path = cfg.data.get("yolo_model", "yolov8n.pt")
        try:
            self.model_status = "LOADING"
            self.add_log(f"AI MODEL YUKLENIYOR: {model_path} ({self.compute_device})")
            self.model = YOLO(model_path)
            self.current_model_name = model_path
            self.model_status = "READY"
            self.add_log(f"AI MODEL HAZIR: {model_path}")
        except Exception as e:
            self.model_status = "ERR"
            self.add_log(f"AI MODEL HATA: {e}")

    def reload_all(self):
        self.main_stream.trigger_reconnect()
        self.test_stream.trigger_reconnect()
        cpdd_ctrl.reload()
        new_model = cfg.data.get("yolo_model", "yolov8n.pt")
        if new_model != self.current_model_name:
            threading.Thread(target=self._load_model_async, daemon=True).start()

    def test_cameras_and_model(self):
        rtsp_url = self.main_stream._get_source_url()
        test_url = self.test_stream._get_source_url()
        if isinstance(self.test_stream.cap, SequenceFolderCapture):
            total = len(self.test_stream.cap.image_files) or len(self.test_stream.cap.video_files)
            test_url = f"{test_url} [{total} dosya]"

        return {
            "model_ready": self.model is not None,
            "model_status": self.model_status,
            "cpdd_udp": cpdd_ctrl.test_connection(),
            "cameras": {
                "MAIN_RTSP": {
                    "connected": self.main_stream.ret,
                    "status": self.main_stream.status,
                    "error": self.main_stream.error_detail,
                    "url": rtsp_url
                },
                "WEBCAM": {
                    "connected": self.test_stream.ret,
                    "status": self.test_stream.status,
                    "error": self.test_stream.error_detail,
                    "url": test_url
                }
            }
        }

    def set_camera_mode(self, mode: str):
        mode_u = mode.upper().strip()
        if mode_u == "AUTO":
            self.auto_switch_enabled = True
            if self.active_cam_key == "WEBCAM":
                self.active_cam_key = "WIDE"
                self.mav.send_camera_switch_pwm("WIDE")
                cpdd_ctrl.switch_view("WIDE")
        elif mode_u == "WEBCAM":
            self.auto_switch_enabled = False
            self.active_cam_key = "WEBCAM"
        elif mode_u in ("WIDE", "NARROW", "THERMAL", "FUSION"):
            self.auto_switch_enabled = False
            self.active_cam_key = mode_u
            self.mav.send_camera_switch_pwm(mode_u)
            cpdd_ctrl.switch_view(mode_u)

    def lock_target(self, target_id: int):
        self.locked_target_id = int(target_id)
        err_x, err_y = 0.0, 0.0
        for t in self.detected_targets:
            if int(t["id"]) == self.locked_target_id and "cx" in t and "cy" in t:
                self.last_locked_center = (t["cx"], t["cy"])
                err_x = float(t.get("err_x", 0.0))
                err_y = float(t.get("err_y", 0.0))
                break
        cpdd_ctrl.start_hardware_track(err_x, err_y, self.locked_target_id)
        self.mav.bypass_all_safeties()

    def unlock_target(self):
        self.locked_target_id = None
        self.last_locked_center = None
        cpdd_ctrl.stop_hardware_track()
        self.mav.abort_engagement()

    def _evaluate_auto_camera_switch(self, frame, detections):
        if not self.auto_switch_enabled or self.active_cam_key == "WEBCAM":
            return

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        brightness = np.mean(gray)

        if brightness < 38.0 and self.active_cam_key != "THERMAL":
            self.active_cam_key = "THERMAL"
            self.mav.send_camera_switch_pwm("THERMAL")
            cpdd_ctrl.switch_view("THERMAL")
            return

        if self.locked_target_id is not None and self.active_cam_key != "NARROW" and brightness >= 38.0:
            self.active_cam_key = "NARROW"
            self.mav.send_camera_switch_pwm("NARROW")
            cpdd_ctrl.switch_view("NARROW")
            return

        if len(detections) > 0 and self.active_cam_key == "WIDE":
            h, w, _ = frame.shape
            frame_area = w * h
            for det in detections:
                box_area = (det["x2"] - det["x1"]) * (det["y2"] - det["y1"])
                if (box_area / frame_area) < 0.025:
                    self.active_cam_key = "NARROW"
                    self.mav.send_camera_switch_pwm("NARROW")
                    cpdd_ctrl.switch_view("NARROW")
                    return
        elif len(detections) == 0 and self.locked_target_id is None and self.active_cam_key != "WIDE" and brightness >= 38.0:
            self.active_cam_key = "WIDE"
            self.mav.send_camera_switch_pwm("WIDE")
            cpdd_ctrl.switch_view("WIDE")

    def _encode_crop_base64(self, frame, x1, y1, x2, y2):
        h, w, _ = frame.shape
        pad = 15
        cx1, cy1 = max(0, x1 - pad), max(0, y1 - pad)
        cx2, cy2 = min(w, x2 + pad), min(h, y2 + pad)
        crop = frame[cy1:cy2, cx1:cx2]
        if crop.size == 0:
            return ""
        crop_resized = cv2.resize(crop, (140, 140))
        _, buf = cv2.imencode(".jpg", crop_resized, [cv2.IMWRITE_JPEG_QUALITY, 75])
        return base64.b64encode(buf).decode("utf-8")

    def _get_boresight_pixel_y(self, fh: int) -> int:
        tilt_deg = float(cfg.data.get("camera_tilt_deg", 30.0))
        vfov_deg = max(20.0, float(cfg.data.get("camera_vfov_deg", 60.0)))
        offset_norm = tilt_deg / (vfov_deg / 2.0)
        bs_y = int((fh / 2.0) * (1.0 + offset_norm))
        return max(10, min(fh - 10, bs_y))

    def _draw_tactical_reticle(self, frame, x1, y1, x2, y2, track_id, conf, is_locked, cls_label="TGT", est_dist_m=0.0):
        color = (25, 25, 255) if is_locked else (85, 255, 110)
        thickness = 3 if is_locked else 2
        w = x2 - x1
        h = y2 - y1
        line_len = max(12, min(w, h) // 3)
        fh, fw, _ = frame.shape

        cv2.line(frame, (x1, y1), (x1 + line_len, y1), color, thickness)
        cv2.line(frame, (x1, y1), (x1, y1 + line_len), color, thickness)
        cv2.line(frame, (x2, y1), (x2 - line_len, y1), color, thickness)
        cv2.line(frame, (x2, y1), (x2, y1 + line_len), color, thickness)
        cv2.line(frame, (x1, y2), (x1 + line_len, y2), color, thickness)
        cv2.line(frame, (x1, y2), (x1, y2 - line_len), color, thickness)
        cv2.line(frame, (x2, y2), (x2 - line_len, y2), color, thickness)
        cv2.line(frame, (x2, y2), (x2, y2 - line_len), color, thickness)

        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        tag = f"TD-{track_id:02d} [{cls_label}] {int(conf*100)}%"
        if is_locked:
            cv2.rectangle(frame, (x1, y1), (x2, y2), (25, 25, 255), 1)
            tag = f"[STT LOCK] {tag}"
            bs_y = self._get_boresight_pixel_y(fh)
            cv2.line(frame, (fw // 2, bs_y), (cx, cy), (25, 25, 255), 2)
            cv2.circle(frame, (cx, cy), 4, (25, 25, 255), -1)

        cv2.putText(frame, tag, (x1, max(20, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.50, color, 2, cv2.LINE_AA)

        dist_text = f"~{int(round(est_dist_m))} m"
        (tw, th), _ = cv2.getTextSize(dist_text, cv2.FONT_HERSHEY_SIMPLEX, 0.52, 2)
        tx = max(6, min(fw - tw - 6, cx - tw // 2))
        ty = min(fh - 10, y2 + th + 10)

        cv2.rectangle(frame, (tx - 4, ty - th - 3), (tx + tw + 4, ty + 4), (10, 14, 12), -1)
        cv2.putText(frame, dist_text, (tx, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.52, color, 2, cv2.LINE_AA)

    def _generate_standby_frame(self):
        blank = np.full((720, 1280, 3), (6, 10, 8), dtype=np.uint8)
        _, jpeg = cv2.imencode(".jpg", blank)
        return jpeg.tobytes()

    def _process_loop(self):
        while self.running:
            stream = self._get_active_stream()

            if not stream or not stream.ret or stream.frame is None:
                self.detected_targets = []
                self.latest_annotated_jpeg = self._generate_standby_frame()
                time.sleep(0.08)
                continue

            frame = stream.frame.copy()
            fh, fw, _ = frame.shape

            current_targets = []
            raw_boxes = []
            locked_target_found = False

            self._frame_idx += 1
            skip_n = int(cfg.data.get("ai_frame_skip", 1))
            if not torch.cuda.is_available() and skip_n < 2:
                skip_n = 2  # CPU modunda her 2 karede 1 AI calistirarak goruntuyu 2x akici tut

            if self.model is not None:
                try:
                    if (self._frame_idx % skip_n == 0) or not self._last_cached_dets:
                        t_inf0 = time.time()
                        imgsz_val = int(cfg.data.get("yolo_imgsz", 416))
                        results = self.model.track(
                            frame,
                            persist=True,
                            imgsz=imgsz_val,
                            conf=float(cfg.data.get("confidence_threshold", 0.45)),
                            classes=cfg.get_target_classes_list(),
                            verbose=False
                        )
                        self.infer_ms = round((time.time() - t_inf0) * 1000.0, 1)

                        detections_tmp = []
                        if results and len(results[0].boxes) > 0:
                            boxes = results[0].boxes
                            for i, box in enumerate(boxes):
                                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                                conf = float(box.conf[0])
                                cls_id = int(box.cls[0]) if box.cls is not None else -1
                                cls_label = TACTICAL_CLASS_LABELS.get(cls_id, f"CLS-{cls_id}")
                                track_id = int(box.id[0]) if box.id is not None else (i + 1)
                                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                                detections_tmp.append({
                                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                                    "conf": conf, "id": track_id, "cx": cx, "cy": cy,
                                    "cls_id": cls_id, "cls_label": cls_label
                                })
                        self._last_cached_dets = detections_tmp
                    else:
                        detections_tmp = self._last_cached_dets

                    if len(detections_tmp) > 0:

                        if self.locked_target_id is not None:
                            ids_in_frame = [d["id"] for d in detections_tmp]
                            if self.locked_target_id not in ids_in_frame:
                                if self.last_locked_center is not None:
                                    lx, ly = self.last_locked_center
                                    closest = min(detections_tmp, key=lambda d: (d["cx"] - lx)**2 + (d["cy"] - ly)**2)
                                else:
                                    closest = detections_tmp[0]
                                self.locked_target_id = closest["id"]

                        for det in detections_tmp:
                            x1, y1, x2, y2 = det["x1"], det["y1"], det["x2"], det["y2"]
                            cx, cy = det["cx"], det["cy"]
                            track_id, conf = det["id"], det["conf"]

                            raw_boxes.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2})
                            err_x = (cx - (fw / 2)) / (fw / 2)

                            tilt_deg = float(cfg.data.get("camera_tilt_deg", 30.0))
                            vfov_deg = max(20.0, float(cfg.data.get("camera_vfov_deg", 60.0)))
                            drone_pitch = float(self.mav.telemetry.get("pitch", 0.0))
                            pixel_angle_y = -((cy - (fh / 2)) / (fh / 2)) * (vfov_deg / 2.0)
                            net_target_elev_deg = pixel_angle_y + tilt_deg + drone_pitch
                            err_y = -net_target_elev_deg / (vfov_deg / 2.0)

                            is_locked = (self.locked_target_id == track_id)
                            if is_locked:
                                locked_target_found = True
                                self.last_locked_center = (cx, cy)
                                self.mav.send_intercept_attitude(err_x, err_y)

                            cls_label = det.get("cls_label", "TGT")
                            box_w_ratio = max(0.015, (x2 - x1) / float(fw))
                            est_dist_m = round(min(450.0, max(25.0, 22.0 / box_w_ratio)), 1)
                            self._draw_tactical_reticle(frame, x1, y1, x2, y2, track_id, conf, is_locked, cls_label, est_dist_m)
                            current_targets.append({
                                "id": track_id,
                                "cls_label": cls_label,
                                "conf": round(conf * 100, 1),
                                "locked": is_locked,
                                "cx": cx,
                                "cy": cy,
                                "est_dist_m": est_dist_m,
                                "thumbnail": self._encode_crop_base64(frame, x1, y1, x2, y2),
                                "err_x": round(err_x, 2),
                                "err_y": round(err_y, 2)
                            })
                except Exception:
                    pass

            if self.locked_target_id is not None and not locked_target_found and self.last_locked_center:
                lx, ly = self.last_locked_center
                err_x = (lx - (fw / 2)) / (fw / 2)
                tilt_deg = float(cfg.data.get("camera_tilt_deg", 30.0))
                vfov_deg = max(20.0, float(cfg.data.get("camera_vfov_deg", 60.0)))
                drone_pitch = float(self.mav.telemetry.get("pitch", 0.0))
                pixel_angle_y = -((ly - (fh / 2)) / (fh / 2)) * (vfov_deg / 2.0)
                net_target_elev_deg = pixel_angle_y + tilt_deg + drone_pitch
                err_y = -net_target_elev_deg / (vfov_deg / 2.0)
                self.mav.send_intercept_attitude(err_x, err_y)

            self.detected_targets = current_targets
            self._evaluate_auto_camera_switch(frame, raw_boxes)

            jq = int(cfg.data.get("stream_jpeg_quality", 68))
            _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, jq])
            self.latest_annotated_jpeg = jpeg.tobytes()

            self._loop_counter += 1
            now_l = time.time()
            if now_l - self._loop_fps_t >= 1.0:
                self.pipeline_fps = round(self._loop_counter / (now_l - self._loop_fps_t), 1)
                self._loop_counter = 0
                self._loop_fps_t = now_l
            time.sleep(0.002)
