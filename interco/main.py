import os
# main.py
import time
import asyncio
import webbrowser
import threading
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel
import uvicorn

from config import cfg
from mavlink_handler import MavlinkController
from vision_engine import VisionSystem
from cpdd_gimbal import cpdd_ctrl

app = FastAPI(title="INTERCO CPDD075 + 3D Cesium GCS")

mav_ctrl = MavlinkController()
vision_sys = VisionSystem(mav_ctrl)

class LockRequest(BaseModel):
    target_id: int

class CameraRequest(BaseModel):
    mode: str

class FlightCmdRequest(BaseModel):
    cmd: str
    alt: float = 50.0

class ModeRequest(BaseModel):
    mode: str

class CpddCmdRequest(BaseModel):
    action: str

@app.get("/", response_class=HTMLResponse)
async def index():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return f.read()

def mjpeg_generator():
    while True:
        if vision_sys.latest_annotated_jpeg:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + vision_sys.latest_annotated_jpeg + b"\r\n"
            )
        time.sleep(0.033)

@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(mjpeg_generator(), media_type="multipart/x-mixed-replace; boundary=frame")

@app.post("/api/lock")
async def api_lock_target(req: LockRequest):
    vision_sys.lock_target(req.target_id)
    return {"status": "ENGAGED", "target_id": req.target_id}

@app.post("/api/abort")
async def api_abort():
    vision_sys.unlock_target()
    return {"status": "POSHOLD", "engaged": False, "locked_target_id": None}

@app.post("/api/set_mode")
async def api_set_mode(req: ModeRequest):
    vision_sys.locked_target_id = None
    mav_ctrl.set_flight_mode(req.mode)
    return {"status": "OK", "mode": req.mode.upper()}

@app.post("/api/flight_cmd")
async def api_flight_cmd(req: FlightCmdRequest):
    cmd = req.cmd.upper().strip()
    if cmd == "RTL":
        vision_sys.locked_target_id = None
        mav_ctrl.command_rtl()
    elif cmd == "TAKEOFF":
        mav_ctrl.command_takeoff(req.alt)
    elif cmd == "LAND":
        vision_sys.locked_target_id = None
        mav_ctrl.command_land()
    elif cmd == "POSHOLD":
        vision_sys.locked_target_id = None
        mav_ctrl.command_poshold()
    return {"status": "OK", "cmd": cmd}

@app.post("/api/camera")
async def api_set_camera(req: CameraRequest):
    vision_sys.set_camera_mode(req.mode)
    return {
        "status": "OK",
        "active_camera": vision_sys.active_cam_key,
        "cpdd_view": cpdd_ctrl.current_view
    }

@app.post("/api/cpdd/cmd")
async def api_cpdd_cmd(req: CpddCmdRequest):
    act = req.action.upper().strip()
    if act == "ZOOM_IN":
        cpdd_ctrl.zoom_step(1)
    elif act == "ZOOM_OUT":
        cpdd_ctrl.zoom_step(-1)
    elif act == "IR_PALETTE":
        cpdd_ctrl.switch_ir_palette()
    elif act == "CENTER":
        cpdd_ctrl.gimbal_center()
    elif act == "FUSION":
        vision_sys.set_camera_mode("FUSION")
    return {
        "status": "OK",
        "action": act,
        "zoom_level": cpdd_ctrl.zoom_level,
        "ir_palette": cpdd_ctrl.ir_palette_idx,
        "cpdd_view": cpdd_ctrl.current_view
    }


class CpddRawRequest(BaseModel):
    mode: str = "TEXT"   # "TEXT" veya "HEX"
    text_cmd: str = ""
    type_b: str = "2F"
    type_cd: str = "01 00 00 00"

@app.post("/api/cpdd/raw")
async def api_cpdd_raw(req: CpddRawRequest):
    if req.mode.upper() == "HEX":
        ok = await asyncio.to_thread(cpdd_ctrl.send_custom_hex, req.type_b, req.type_cd)
        return {"ok": ok, "reply": f"HEX GÖNDERİLDİ -> TypeB:{req.type_b} TypeCD:{req.type_cd}"}
    else:
        reply = await asyncio.to_thread(cpdd_ctrl.send_text_cmd, req.text_cmd, True)
        return {"ok": True, "reply": reply if reply else "(UDP gönderildi, metin yanıtı dönmedi)"}

@app.get("/api/scan_webcams")
async def api_scan_webcams():
    cams = await asyncio.to_thread(vision_sys.scan_local_webcams)
    return {"webcams": cams}

@app.get("/api/dataset_folders")
async def api_dataset_folders():
    folders = await asyncio.to_thread(vision_sys.scan_dataset_folders)
    return {"folders": folders}

@app.get("/api/settings")
async def get_settings():
    return cfg.data

@app.post("/api/settings/save_and_test")
async def save_and_test_settings(payload: dict):
    cfg.save(payload)
    mav_ctrl.reconnect()
    vision_sys.reload_all()
    await asyncio.sleep(1.2)
    conn_str = cfg.get_mavlink_connection_string()
    mav_test = mav_ctrl.test_connection(conn_str)
    vis_test = vision_sys.test_cameras_and_model()
    return {
        "saved": True,
        "mavlink": mav_test,
        "vision": vis_test
    }

@app.websocket("/ws/telemetry")
async def websocket_telemetry(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            stream = vision_sys._get_active_stream()
            active_cam_online = bool(stream and stream.ret)
            active_cam_status = stream.status if stream else "NO VIDEO"
            active_cam_error = stream.error_detail if stream else ""

            payload = {
                "telemetry": mav_ctrl.telemetry,
                "active_camera": vision_sys.active_cam_key,
                "active_cam_online": active_cam_online,
                "active_cam_status": active_cam_status,
                "active_cam_error": active_cam_error,
                "auto_camera": vision_sys.auto_switch_enabled,
                "locked_target_id": vision_sys.locked_target_id,
                "targets": vision_sys.detected_targets,
                "model_status": vision_sys.model_status,
                "perf": {
                    "cam_fps": stream.stream_fps if stream else 0.0,
                    "out_fps": vision_sys.pipeline_fps,
                    "infer_ms": vision_sys.infer_ms,
                    "device": vision_sys.compute_device,
                    "decoder": stream.decoder_type if stream else "NONE",
                    "res": f"{stream.frame.shape[1]}x{stream.frame.shape[0]}" if (stream and stream.frame is not None) else "-"
                },
                "logs": list(vision_sys.logs)[-18:],
                "cpdd": {
                    "view": cpdd_ctrl.current_view,
                    "zoom": cpdd_ctrl.zoom_level,
                    "palette": cpdd_ctrl.ir_palette_idx,
                    "status": cpdd_ctrl.last_status
                }
            }
            await websocket.send_json(payload)
            await asyncio.sleep(0.04)
    except WebSocketDisconnect:
        pass

if __name__ == "__main__":
    port = int(cfg.data.get("web_port", 8005))
    host = cfg.data.get("web_host", "0.0.0.0")
    print(f"INTERCO CPDD075 GCS AKTIF -> http://{host}:{port}")
    if os.environ.get("INTERCO_HEADLESS", "0") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    uvicorn.run("main:app", host=host, port=port, reload=False)
