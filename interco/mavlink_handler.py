# mavlink_handler.py
import os
import time
import math
import socket
import threading

os.environ["MAVLINK20"] = "1"

from pymavlink import mavutil
from config import cfg

HOME_LAT = 39.925533
HOME_LON = 32.866287

class MavlinkController:
    def __init__(self):
        self.master = None
        self.running = True
        self.connected = False
        self.last_heartbeat = 0
        self.last_stream_req = 0
        self.status_msg = "LINK BEKLENIYOR"
        self.current_conn_str = ""
        self.lock = threading.Lock()

        self.sitl_state = {
            "mode": "STBY",
            "armed": False,
            "in_air": False,
            "roll": 0.0,
            "pitch": 0.0,
            "yaw": 45.0,
            "alt": 0.0,
            "target_alt": 50.0,
            "speed": 0.0,
            "climb": 0.0,
            "throttle": 0,
            "battery_v": 25.2,
            "home_lat": HOME_LAT,
            "home_lon": HOME_LON,
            "lat": HOME_LAT,
            "lon": HOME_LON,
            "cmd_roll_rate": 0.0,
            "cmd_pitch_rate": 0.0,
            "cmd_yaw_rate": 0.0,
            "cmd_thrust": 0.0,
            "last_cmd_time": 0.0
        }

        self.telemetry = {
            "connected": False,
            "status_msg": self.status_msg,
            "armed": False,
            "in_air": False,
            "mode": "STBY",
            "roll": 0.0,
            "pitch": 0.0,
            "yaw": 45.0,
            "alt": 0.0,
            "climb": 0.0,
            "groundspeed": 0.0,
            "airspeed": 0.0,
            "throttle": 0,
            "battery_v": 25.2,
            "battery_pct": 100,
            "home_lat": HOME_LAT,
            "home_lon": HOME_LON,
            "lat": HOME_LAT,
            "lon": HOME_LON,
            "satellites": 18,
            "engaged": False
        }
        threading.Thread(target=self._connection_worker, daemon=True).start()

    def reset_sitl(self):
        self.sitl_state.update({
            "mode": "STBY",
            "armed": False,
            "in_air": False,
            "roll": 0.0,
            "pitch": 0.0,
            "yaw": 45.0,
            "alt": 0.0,
            "target_alt": 50.0,
            "speed": 0.0,
            "climb": 0.0,
            "throttle": 0,
            "battery_v": 25.2,
            "lat": self.sitl_state["home_lat"],
            "lon": self.sitl_state["home_lon"],
            "cmd_roll_rate": 0.0,
            "cmd_pitch_rate": 0.0,
            "cmd_yaw_rate": 0.0,
            "cmd_thrust": 0.0,
            "last_cmd_time": 0.0
        })
        self.telemetry["engaged"] = False
        self.telemetry["armed"] = False
        self.telemetry["in_air"] = False
        self.telemetry["mode"] = "STBY"

    def reconnect(self):
        with self.lock:
            self.connected = False
            self.telemetry["connected"] = False
            self.status_msg = "LINK YENILENIYOR"
            self.telemetry["status_msg"] = self.status_msg
            if self.master:
                try:
                    self.master.close()
                except Exception:
                    pass
                self.master = None
            if cfg.get_mavlink_connection_string() == "sitl:internal:sim":
                self.reset_sitl()

    def test_connection(self, conn_str: str):
        try:
            if conn_str == "sitl:internal:sim":
                return {"ok": True, "msg": "DAHİLİ SITL SİMÜLATÖRÜ AKTİF (Yerde Kalkışa Hazır - 25 Hz)"}

            parts = conn_str.split(":")
            proto = parts[0].lower()
            host = parts[1]
            port = int(parts[2])

            if self.connected and self.current_conn_str == conn_str:
                sys_id = getattr(self.master, "target_system", 1)
                return {"ok": True, "msg": f"{proto.upper()} TELEMETRİ AKIŞI AKTİF ({host}:{port} | SYS:{sys_id})"}

            if proto == "tcp":
                if self.master is not None and self.current_conn_str == conn_str:
                    return {"ok": True, "msg": f"TCP SOKETİ AÇIK ({host}:{port}) - MAVLink Heartbeat bekleniyor..."}
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(1.0)
                res = sock.connect_ex((host, port))
                sock.close()
                if res == 0:
                    return {"ok": True, "msg": f"TCP SUNUCUSU ERİŞİLEBİLİR ({host}:{port})"}
                return {"ok": False, "msg": f"TCP HEDEFE ULAŞILAMIYOR ({host}:{port}) - Port kapalı veya başka program kullanıyor"}

            elif proto == "tcpin":
                return {"ok": True, "msg": f"TCP SERVER DİNLENİYOR ({host}:{port})"}
            else:
                return {"ok": True, "msg": f"UDP PORTU DİNLENİYOR ({host}:{port})"}

        except Exception as e:
            return {"ok": False, "msg": f"BAĞLANTI HATASI: {str(e)}"}


    def send_camera_switch_pwm(self, mode_name: str):
        """
        CPDD075 / FPV kamera modülünde kamera lensleri arası geçiş için
        uçuş kontrol kartı üzerinden seçili kanala (varsayılan Kanal 8) PWM sinyali gönderir.
        WIDE: 1100 us | NARROW: 1500 us | THERMAL: 1900 us
        """
        mode_u = str(mode_name).upper().strip()
        ch = int(cfg.data.get("cam_switch_channel", 8))
        pwm_wide = int(cfg.data.get("cam_pwm_wide", 1100))
        pwm_narrow = int(cfg.data.get("cam_pwm_narrow", 1500))
        pwm_thermal = int(cfg.data.get("cam_pwm_thermal", 1900))

        if mode_u == "WIDE":
            pwm_val = pwm_wide
        elif mode_u in ("NARROW", "FUSION"):
            pwm_val = pwm_narrow
        elif mode_u == "THERMAL":
            pwm_val = pwm_thermal
        else:
            return None

        self.telemetry["cam_pwm_ch"] = ch
        self.telemetry["cam_pwm_val"] = pwm_val
        print(f"[INTERCO] KAMERA GECIS PWM -> KANAL {ch} = {pwm_val} us ({mode_u})")

        if cfg.get_mavlink_connection_string() == "sitl:internal:sim":
            return pwm_val

        if not self.connected or not self.master:
            return pwm_val

        try:
            # 1) MAVLink RC_CHANNELS_OVERRIDE (1..18 kanal desteği)
            rc_vals = [65535] * 18
            if 1 <= ch <= 18:
                rc_vals[ch - 1] = pwm_val
            self.master.mav.rc_channels_override_send(
                self.master.target_system,
                self.master.target_component,
                *rc_vals
            )
            # 2) Doğrudan Servo/Aux çıkışı kullanılıyorsa MAV_CMD_DO_SET_SERVO da gönder
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_DO_SET_SERVO,
                0,
                float(ch),
                float(pwm_val),
                0, 0, 0, 0, 0
            )
        except Exception as e:
            print(f"[MAVLINK] Kamera PWM gonderim hatasi: {e}")

        return pwm_val

    def set_flight_mode(self, mode_name: str):
        mode_upper = str(mode_name).upper().strip()
        self.telemetry["engaged"] = False
        self.sitl_state["mode"] = mode_upper
        self.telemetry["mode"] = mode_upper
        print(f"[INTERCO] MOD DEGISTIRILDI -> {mode_upper}")

        if mode_upper in ("TAKEOFF", "GUIDED", "AUTO", "LOITER", "POSHOLD", "ALT_HOLD", "STABILIZE", "ACRO", "SPORT"):
            if self.sitl_state["alt"] > 0.5:
                self.sitl_state["in_air"] = True

        if cfg.get_mavlink_connection_string() != "sitl:internal:sim" and self.connected and self.master:
            try:
                self.master.set_mode(mode_upper)
            except Exception as e:
                print(f"[MAVLINK] Mod degistirme hatasi ({mode_upper}): {e}")

    def command_rtl(self):
        self.telemetry["engaged"] = False
        self.sitl_state["mode"] = "RTL"
        self.telemetry["mode"] = "RTL"
        print("[INTERCO] KOMUT: EVE DON (RTL)")
        if cfg.get_mavlink_connection_string() != "sitl:internal:sim" and self.connected and self.master:
            try:
                self.master.set_mode("RTL")
            except Exception:
                pass

    def command_takeoff(self, target_alt: float = 50.0):
        target_alt = max(5.0, float(target_alt))
        self.telemetry["engaged"] = False
        self.sitl_state["armed"] = True
        self.sitl_state["in_air"] = True
        self.sitl_state["mode"] = "TAKEOFF"
        self.sitl_state["target_alt"] = target_alt
        self.telemetry["armed"] = True
        self.telemetry["in_air"] = True
        self.telemetry["mode"] = "TAKEOFF"
        print(f"[INTERCO] KOMUT: KALKIS (Hedef Irtifa: {target_alt}m)")
        if cfg.get_mavlink_connection_string() != "sitl:internal:sim" and self.connected and self.master:
            try:
                self.master.set_mode("GUIDED")
                self.master.arducopter_arm()
                time.sleep(0.2)
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
                    0, 0, 0, 0, 0, 0, 0, float(target_alt)
                )
            except Exception:
                pass

    def command_land(self):
        self.telemetry["engaged"] = False
        self.sitl_state["mode"] = "LAND"
        self.telemetry["mode"] = "LAND"
        print("[INTERCO] KOMUT: INIS (LAND)")
        if cfg.get_mavlink_connection_string() != "sitl:internal:sim" and self.connected and self.master:
            try:
                self.master.set_mode("LAND")
            except Exception:
                pass

    def command_poshold(self):
        self.telemetry["engaged"] = False
        if self.sitl_state["in_air"]:
            self.sitl_state["mode"] = "POSHOLD"
            self.telemetry["mode"] = "POSHOLD"
        else:
            self.sitl_state["mode"] = "STBY"
            self.telemetry["mode"] = "STBY"
        print("[INTERCO] KOMUT: POSITION HOLD")
        if cfg.get_mavlink_connection_string() != "sitl:internal:sim" and self.connected and self.master:
            try:
                self.master.set_mode("POSHOLD")
            except Exception:
                try:
                    self.master.set_mode("LOITER")
                except Exception:
                    pass

    def _step_internal_sitl(self, dt: float):
        st = self.sitl_state
        now = time.time()
        engaged = self.telemetry["engaged"]

        if engaged:
            st["mode"] = "INTERCEPT"
            st["armed"] = True
            st["in_air"] = True

        mode = st["mode"]

        if mode in ("STBY", "LANDED"):
            st["alt"] = 0.0
            st["speed"] = 0.0
            st["climb"] = 0.0
            st["roll"] = 0.0
            st["pitch"] = 0.0
            st["throttle"] = 0
            st["in_air"] = False
            st["armed"] = False

        elif mode == "TAKEOFF":
            st["in_air"] = True
            st["armed"] = True
            st["roll"] += (0.0 - st["roll"]) * min(1.0, dt * 6.0)
            st["pitch"] += (0.0 - st["pitch"]) * min(1.0, dt * 6.0)
            st["speed"] = 0.0
            alt_err = st["target_alt"] - st["alt"]
            if alt_err > 0.6:
                st["climb"] = min(8.5, max(2.5, alt_err * 0.65))
                st["alt"] += st["climb"] * dt
                st["throttle"] = 80
            else:
                st["alt"] = st["target_alt"]
                st["climb"] = 0.0
                st["pitch"] = 0.0
                st["throttle"] = 52
                st["mode"] = "POSHOLD"

        elif mode == "POSHOLD":
            st["roll"] += (0.0 - st["roll"]) * min(1.0, dt * 5.0)
            st["pitch"] += (0.0 - st["pitch"]) * min(1.0, dt * 5.0)
            st["speed"] += (0.0 - st["speed"]) * min(1.0, dt * 4.0)
            st["climb"] = 0.0
            st["throttle"] = 50
            st["in_air"] = st["alt"] > 0.5

        elif mode == "INTERCEPT":
            cam_tilt = float(cfg.data.get("camera_tilt_deg", 30.0))
            cruise_forward_pitch = -max(20.0, min(45.0, cam_tilt))

            if now - st["last_cmd_time"] < 2.0:
                target_yaw_rate = math.degrees(st["cmd_yaw_rate"]) * 1.8
                desired_pitch = max(-65.0, min(-10.0, cruise_forward_pitch + math.degrees(st["cmd_pitch_rate"]) * 0.45))
                target_pitch_rate = (desired_pitch - st["pitch"]) * 3.5
                target_roll = max(-65.0, min(65.0, target_yaw_rate * 1.4))
            else:
                target_yaw_rate = 0.0
                target_pitch_rate = (cruise_forward_pitch - st["pitch"]) * 2.5
                target_roll = 0.0

            st["yaw"] = (st["yaw"] + target_yaw_rate * dt) % 360
            st["pitch"] = max(-75.0, min(15.0, st["pitch"] + target_pitch_rate * dt))
            st["roll"] += (target_roll - st["roll"]) * min(1.0, dt * 8.0)
            st["throttle"] = 100

            forward_factor = max(0.4, math.sin(math.radians(-st["pitch"])))
            target_spd = 55.0 + forward_factor * 45.0
            st["speed"] += (target_spd - st["speed"]) * min(1.0, dt * 3.5)

            net_elev = st["pitch"] + cam_tilt
            if st["alt"] < 20.0 and net_elev < 4.0:
                st["climb"] = 6.5
            else:
                st["climb"] = st["speed"] * math.sin(math.radians(net_elev)) * 0.45
            st["alt"] = max(1.0, st["alt"] + st["climb"] * dt)

        elif mode == "RTL":
            if not st["in_air"]:
                st["mode"] = "STBY"
            else:
                dlat = (st["home_lat"] - st["lat"]) * 111320.0
                dlon = (st["home_lon"] - st["lon"]) * (111320.0 * math.cos(math.radians(st["lat"])))
                dist_home = math.hypot(dlat, dlon)
                if dist_home > 3.0:
                    target_hdg = (math.degrees(math.atan2(dlon, dlat)) + 360) % 360
                    diff = ((target_hdg - st["yaw"] + 540) % 360) - 180
                    st["yaw"] = (st["yaw"] + max(-60.0, min(60.0, diff * 2.0)) * dt) % 360
                    st["roll"] += (max(-25.0, min(25.0, diff * 0.6)) - st["roll"]) * min(1.0, dt * 4.0)
                    st["speed"] += (22.0 - st["speed"]) * min(1.0, dt * 3.0)
                    alt_err = max(30.0, st["target_alt"]) - st["alt"]
                    st["climb"] = max(-8.0, min(8.0, alt_err * 0.5))
                    st["alt"] = max(5.0, st["alt"] + st["climb"] * dt)
                    st["pitch"] = math.degrees(math.atan2(st["climb"], max(1.0, st["speed"])))
                    st["throttle"] = 65
                else:
                    st["mode"] = "LAND"

        elif mode == "LAND":
            st["roll"] += (0.0 - st["roll"]) * min(1.0, dt * 5.0)
            st["pitch"] += (0.0 - st["pitch"]) * min(1.0, dt * 5.0)
            st["speed"] += (0.0 - st["speed"]) * min(1.0, dt * 4.0)
            if st["alt"] > 0.2:
                st["climb"] = -4.0 if st["alt"] > 10.0 else -1.8
                st["alt"] = max(0.0, st["alt"] + st["climb"] * dt)
                st["throttle"] = 30
            else:
                st["alt"] = 0.0
                st["climb"] = 0.0
                st["speed"] = 0.0
                st["throttle"] = 0
                st["in_air"] = False
                st["armed"] = False
                st["mode"] = "LANDED"

        elif mode in ("STABILIZE", "ALT_HOLD", "LOITER", "ACRO", "SPORT"):
            if st["in_air"]:
                st["roll"] += (0.0 - st["roll"]) * min(1.0, dt * 4.0)
                st["pitch"] += (0.0 - st["pitch"]) * min(1.0, dt * 4.0)
                st["speed"] += (0.0 - st["speed"]) * min(1.0, dt * 3.0)
                st["climb"] = 0.0
                st["throttle"] = 50
            else:
                st["alt"] = 0.0
                st["speed"] = 0.0
                st["climb"] = 0.0
                st["throttle"] = 0

        else:
            st["in_air"] = True
            t_wave = math.sin(now * 0.5)
            target_roll = t_wave * 10.0
            st["roll"] += (target_roll - st["roll"]) * min(1.0, dt * 3.0)
            st["yaw"] = (st["yaw"] + (st["roll"] * 0.45) * dt) % 360
            alt_err = 140.0 - st["alt"]
            target_pitch = max(-10.0, min(10.0, alt_err * 0.5 - 1.5))
            st["pitch"] += (target_pitch - st["pitch"]) * min(1.0, dt * 3.0)
            st["throttle"] = 62
            st["speed"] += (24.0 - st["speed"]) * min(1.0, dt * 2.0)
            st["climb"] = st["speed"] * math.sin(math.radians(st["pitch"]))
            st["alt"] = max(5.0, st["alt"] + st["climb"] * dt)

        if st["speed"] > 0.1 and st["in_air"]:
            dist = st["speed"] * dt
            rad_yaw = math.radians(st["yaw"])
            st["lat"] += (dist * math.cos(rad_yaw)) / 111320.0
            st["lon"] += (dist * math.sin(rad_yaw)) / (111320.0 * math.cos(math.radians(st["lat"])))

        drain = 0.008 if engaged else (0.001 if st["in_air"] else 0.0001)
        st["battery_v"] = max(19.5, st["battery_v"] - drain * dt)

        self.telemetry["connected"] = True
        self.telemetry["status_msg"] = "SITL SIM AKTIF [SYS:1]"
        self.telemetry["armed"] = st["armed"]
        self.telemetry["in_air"] = st["in_air"]
        self.telemetry["mode"] = st["mode"]
        self.telemetry["roll"] = round(st["roll"], 2)
        self.telemetry["pitch"] = round(st["pitch"], 2)
        self.telemetry["yaw"] = round(st["yaw"], 2)
        self.telemetry["alt"] = round(st["alt"], 1)
        self.telemetry["climb"] = round(st["climb"], 1)
        self.telemetry["groundspeed"] = round(st["speed"], 1)
        self.telemetry["airspeed"] = round(st["speed"] * 1.03, 1)
        self.telemetry["throttle"] = int(st["throttle"])
        self.telemetry["battery_v"] = round(st["battery_v"], 2)
        self.telemetry["home_lat"] = round(st["home_lat"], 6)
        self.telemetry["home_lon"] = round(st["home_lon"], 6)
        self.telemetry["lat"] = round(st["lat"], 6)
        self.telemetry["lon"] = round(st["lon"], 6)
        self.telemetry["satellites"] = 18

    def _send_gcs_heartbeat_and_stream_req(self):
        if not self.master:
            return
        try:
            self.master.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_GCS,
                mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                0, 0, 0
            )
            t_sys = self.master.target_system if self.master.target_system else 1
            t_comp = self.master.target_component if self.master.target_component else 1
            self.master.mav.request_data_stream_send(
                t_sys,
                t_comp,
                mavutil.mavlink.MAV_DATA_STREAM_ALL,
                20, 1
            )
        except Exception:
            pass

    def _connection_worker(self):
        last_sim_t = time.time()
        while self.running:
            target_conn = cfg.get_mavlink_connection_string()

            if target_conn == "sitl:internal:sim":
                now = time.time()
                dt = min(0.1, max(0.01, now - last_sim_t))
                last_sim_t = now
                self.current_conn_str = target_conn
                self.connected = True
                self._step_internal_sitl(dt)
                time.sleep(0.04)
                continue

            last_sim_t = time.time()

            try:
                if self.master is None or self.current_conn_str != target_conn:
                    with self.lock:
                        self.current_conn_str = target_conn
                        proto_label = target_conn.split(":")[0].upper()
                        port_label = target_conn.split(":")[-1]
                        self.status_msg = f"{proto_label} BAGLANIYOR [{port_label}]"
                        self.telemetry["status_msg"] = self.status_msg
                        self.master = mavutil.mavlink_connection(
                            target_conn,
                            source_system=255,
                            autoreconnect=True
                        )
                    time.sleep(0.2)
                    self._send_gcs_heartbeat_and_stream_req()

                now = time.time()
                if now - self.last_stream_req > 1.5:
                    self._send_gcs_heartbeat_and_stream_req()
                    self.last_stream_req = now

                msg = self.master.recv_match(blocking=True, timeout=0.3)
                if not msg:
                    if self.connected and (time.time() - self.last_heartbeat > 5.0):
                        self.connected = False
                        self.telemetry["connected"] = False
                        self.telemetry["status_msg"] = "LINK KAYBI"
                    continue

                msg_type = msg.get_type()
                if msg_type == "BAD_DATA":
                    continue

                if not self.connected:
                    self.connected = True
                    self.telemetry["connected"] = True
                    proto_label = target_conn.split(":")[0].upper()
                    sys_id = msg.get_srcSystem() or 1
                    self.telemetry["status_msg"] = f"{proto_label} AKTIF [SYS:{sys_id}]"
                    self._send_gcs_heartbeat_and_stream_req()

                self.last_heartbeat = time.time()

                if msg_type == "HEARTBEAT":
                    self.telemetry["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                    self.telemetry["mode"] = mavutil.mode_string_v10(msg)

                elif msg_type == "ATTITUDE":
                    self.telemetry["roll"] = round(math.degrees(msg.roll), 2)
                    self.telemetry["pitch"] = round(math.degrees(msg.pitch), 2)
                    self.telemetry["yaw"] = round(math.degrees(msg.yaw) % 360, 2)

                elif msg_type == "VFR_HUD":
                    self.telemetry["airspeed"] = round(msg.airspeed, 1)
                    self.telemetry["groundspeed"] = round(msg.groundspeed, 1)
                    self.telemetry["alt"] = round(msg.alt, 1)
                    self.telemetry["climb"] = round(msg.climb, 1)
                    self.telemetry["throttle"] = int(msg.throttle)
                    self.telemetry["in_air"] = msg.alt > 1.0

                elif msg_type == "SYS_STATUS":
                    self.telemetry["battery_v"] = round(msg.voltage_battery / 1000.0, 2)
                    self.telemetry["battery_pct"] = msg.battery_remaining

                elif msg_type == "GPS_RAW_INT":
                    self.telemetry["lat"] = msg.lat / 1e7
                    self.telemetry["lon"] = msg.lon / 1e7
                    self.telemetry["satellites"] = msg.satellites_visible

            except Exception:
                self.connected = False
                self.telemetry["connected"] = False
                proto_label = target_conn.split(":")[0].upper()
                self.telemetry["status_msg"] = f"{proto_label} BEKLENIYOR..."
                if self.master:
                    try:
                        self.master.close()
                    except Exception:
                        pass
                self.master = None
                time.sleep(1.5)

    def bypass_all_safeties(self):
        cam_tilt = float(cfg.data.get("camera_tilt_deg", 30.0))
        launch_pitch = -max(20.0, min(45.0, cam_tilt))

        self.telemetry["engaged"] = True
        self.telemetry["armed"] = True
        self.telemetry["in_air"] = True
        self.telemetry["mode"] = "INTERCEPT"

        self.sitl_state["armed"] = True
        self.sitl_state["in_air"] = True
        self.sitl_state["mode"] = "INTERCEPT"
        self.sitl_state["pitch"] = launch_pitch
        self.sitl_state["throttle"] = 100
        self.sitl_state["last_cmd_time"] = time.time()

        print(f"[INTERCO] TUTUCUDAN FIRLATMA / ANGAJMAN: ARM + GUIDED + ONE YATIS ({launch_pitch:.0f} deg) + %100 GAZ!")

        if cfg.get_mavlink_connection_string() == "sitl:internal:sim":
            return

        if not self.connected or not self.master:
            return

        safety_params = {
            b"FENCE_ENABLE": 0,
            b"FS_GCS_ENABLE": 0,
            b"FS_THR_ENABLE": 0,
            b"FS_EKF_ACTION": 0,
            b"AVOID_ENABLE": 0,
            b"ARMING_CHECK": 0,
            b"ANGLE_MAX": 8000,
            b"NAV_RCL_ACT": 0,
            b"NAV_DLL_ACT": 0,
            b"COM_OBL_ACT": 0,
            b"GF_ACTION": 0
        }
        for param_id, value in safety_params.items():
            try:
                self.master.mav.param_set_send(
                    self.master.target_system,
                    self.master.target_component,
                    param_id,
                    float(value),
                    mavutil.mavlink.MAV_PARAM_TYPE_REAL32
                )
            except Exception:
                pass

        try:
            self.master.set_mode("GUIDED")
            self.master.arducopter_arm()

            half_p = math.radians(launch_pitch) / 2.0
            q_init = [math.cos(half_p), 0.0, math.sin(half_p), 0.0]
            thrust = float(cfg.data.get("intercept_thrust_max", 1.0))

            self.master.mav.set_attitude_target_send(
                int(time.time() * 1000) & 0xFFFFFFFF,
                self.master.target_system,
                self.master.target_component,
                0b00000111,
                q_init,
                0.0, 0.0, 0.0,
                thrust
            )
        except Exception:
            pass

    def send_intercept_attitude(self, err_x: float, err_y: float):
        yaw_rate = err_x * float(cfg.data.get("yaw_rate_gain", 1.8))
        pitch_rate = -err_y * float(cfg.data.get("pitch_rate_gain", 1.5))
        roll_rate = err_x * 0.8
        thrust = float(cfg.data.get("intercept_thrust_max", 1.0))

        if cfg.get_mavlink_connection_string() == "sitl:internal:sim":
            self.sitl_state["cmd_yaw_rate"] = yaw_rate
            self.sitl_state["cmd_pitch_rate"] = pitch_rate
            self.sitl_state["cmd_roll_rate"] = roll_rate
            self.sitl_state["cmd_thrust"] = thrust
            self.sitl_state["last_cmd_time"] = time.time()
            return

        if not self.connected or not self.master:
            return

        try:
            self.master.mav.set_attitude_target_send(
                int(time.time() * 1000) & 0xFFFFFFFF,
                self.master.target_system,
                self.master.target_component,
                0b10000000,
                [1.0, 0.0, 0.0, 0.0],
                roll_rate,
                pitch_rate,
                yaw_rate,
                thrust
            )
        except Exception:
            pass

    def abort_engagement(self):
        self.command_poshold()
