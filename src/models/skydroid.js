// Kamera modelleri: Skydroid C10 / C10 Pro, C12, C13, C20 (gimballi kameralar).
// Görüntü RTSP ile, kontrol "#TP" metin protokolüyle yapılır (ayrıntı ve kaynaklar: skydroid.driver.js, docs/kamera-modelleri.md).
// Dört model aynı tanım kalıbından üretilir; modele göre yalnızca yetenekler (yakınlaştırma, termal, lazer, C20 ikili kamera protokolü) değişir.
(function (root) {
  'use strict';

  const MODELS = [
    { id: 'skydroidc10', name: 'Skydroid C10 / C10 Pro', path: '/stream=0', caps: { transport: true, media: true } },
    { id: 'skydroidc12', name: 'Skydroid C12', path: '/stream=1', caps: { media: true, zoom: true, thermal: true, osd: true, sd: true } },
    { id: 'skydroidc13', name: 'Skydroid C13', path: '/stream=1', caps: { media: true, zoom: true, thermal: true, scene: true, laser: true, osd: true, sd: true } },
    { id: 'skydroidc20', name: 'Skydroid C20', path: '/main', caps: { c20: true } },
  ];

  const angle = (name) => ({ name, min: -90, max: 90, def: 0, unit: '°', step: 0.1 });

  function panel(caps) {
    const p = [
      { id: 'gimbal', icon: 'crosshair', open: true, controls: [
        { type: 'joystick', cmd: 'joystick', speedKey: 'camJoySpeed', max: 63 },
        { type: 'buttons', items: [{ cmd: 'center', icon: 'home' }, { cmd: 'lookDown', icon: 'download' }, { cmd: 'follow', icon: 'link' }, { cmd: 'lock', icon: 'lock' }, { cmd: 'stop', icon: 'stop' }] },
        { type: 'form', cmd: 'goto', fields: [angle('yaw'), angle('pitch')] },
      ] },
    ];
    if (caps.media) {
      const capture = [{ type: 'buttons', items: [{ cmd: 'photo', icon: 'camera' }, { cmd: 'recordStart', icon: 'record' }, { cmd: 'recordStop', icon: 'stop' }, { cmd: 'recordQuery', icon: 'info' }] }];
      if (caps.sd) capture.push({ type: 'select', cmd: 'recordRes', arg: 'res', options: [0, 1, 2, 3], def: 1, labels: ['720p', '1080p', '2K', '4K'] });
      p.push({ id: 'capture', icon: 'camera', open: true, controls: capture });
    }
    if (caps.zoom) {
      p.push({ id: 'video', icon: 'video', open: true, controls: [
        { type: 'holds', items: [{ cmd: 'zoomIn', icon: 'plus' }, { cmd: 'zoomOut', icon: 'minus' }] },
        { type: 'select', cmd: 'zoomSet', arg: 'level', options: [0, 1, 2, 3, 4], def: 0, labels: ['0', '1', '2', '3', '4'] },
        { type: 'select', cmd: 'ext', arg: 'osd', options: [1, 0], def: 1, extra: { name: 'led', options: [0, 1], def: 0 } },
      ] });
    }
    if (caps.thermal) {
      const th = [{ type: 'select', cmd: 'palette', arg: 'code', options: ['01', '0B', '03', '04', '05', '06', '07', '08', '09', '0A', '0C'], def: '01' }];
      if (caps.scene) {
        th.push({ type: 'select', cmd: 'thermalScene', arg: 'code', options: ['00', '01', '02', '03', '04', '05', '06', '07', '0C', '0D', '0E', '0F'], def: '00' });
        th.push({ type: 'form', cmd: 'thermalTune', fields: [{ name: 'param', options: ['TIB', 'TIC', 'TDI', 'TAS', 'TAR', 'TTR', 'TGM'], def: 'TIB' }, { name: 'value', min: 0, max: 100, def: 50 }] });
      }
      p.push({ id: 'ir', icon: 'palette', controls: th });
    }
    if (caps.laser) p.push({ id: 'laser', icon: 'bolt', controls: [{ type: 'buttons', items: [{ cmd: 'laserOnce', icon: 'crosshair' }] }] });
    if (caps.c20) {
      p.push({ id: 'video', icon: 'video', open: true, controls: [
        { type: 'holds', items: [{ cmd: 'zoomIn', icon: 'plus' }, { cmd: 'zoomOut', icon: 'minus' }, { cmd: 'focusNear', icon: 'crosshair' }, { cmd: 'focusFar', icon: 'expand' }] },
      ] });
      p.push({ id: 'capture', icon: 'camera', open: true, controls: [
        { type: 'buttons', items: [{ cmd: 'photo', icon: 'camera' }, { cmd: 'recordStart', icon: 'record' }, { cmd: 'recordStop', icon: 'stop' }] },
      ] });
    }
    const dev = [];
    if (caps.media) {
      const q = [{ cmd: 'modelQuery', icon: 'info' }, { cmd: 'versionQuery', icon: 'info' }];
      if (caps.sd) q.push({ cmd: 'sdQuery', icon: 'hdd' });
      if (caps.zoom) q.push({ cmd: 'zoomQuery', icon: 'search' });
      q.push({ cmd: 'timeSync', icon: 'clock' });
      dev.push({ type: 'buttons', items: q });
    }
    if (caps.c20) dev.push({ type: 'buttons', items: [{ cmd: 'versionQuery', icon: 'info' }, { cmd: 'stateQuery', icon: 'info' }, { cmd: 'zoomQuery', icon: 'search' }] });
    dev.push({ type: 'raw', cmd: 'raw', as: 'text', placeholder: '#TPUG2wPTZ05' });
    p.push({ id: 'device', icon: 'gear', controls: dev });
    return p;
  }

  function status(caps) {
    const s = [['yaw', 'deg'], ['pitch', 'deg'], ['roll', 'deg']];
    if (caps.zoom) s.push(['zoom', 'int']);
    if (caps.media) s.push(['recording', 'bool']);
    if (caps.laser) s.push(['laser', 'int']);
    if (caps.thermal) s.push(['palette', 'enum']);
    if (caps.c20) s.push(['camLink', 'bool']);
    if (caps.sd) s.push(['sd', 'text']);
    if (caps.media) s.push(['model', 'text']);
    s.push(['version', 'text']);
    return s;
  }

  // Metinler: kısa anahtar → [Türkçe, İngilizce]; her model için cam.<model>.<anahtar> olarak çoğaltılır
  const TEXT = {
    'g.gimbal': ['Yönlendirme', 'Steering'], 'g.capture': ['Kayıt ve fotoğraf', 'Recording and photos'], 'g.video': ['Görüntü', 'Video'],
    'g.ir': ['Termal', 'Thermal'], 'g.laser': ['Lazer mesafe', 'Laser ranging'], 'g.device': ['Cihaz', 'Device'],
    center: ['Ortala', 'Center'], lookDown: ['Dikey aşağı bak', 'Look straight down'], follow: ['Burnu izle', 'Follow mode'], lock: ['Yönü kilitle', 'Lock mode'], stop: ['Durdur', 'Stop'],
    goto: ['Açıya git', 'Go to angle'], yaw: ['Yön', 'Yaw'], pitch: ['Yükseliş', 'Pitch'],
    photo: ['Fotoğraf çek', 'Take photo'], recordStart: ['Karta kaydet', 'Record to card'], recordStop: ['Kaydı bitir', 'Stop recording'], recordQuery: ['Kayıt durumu', 'Recording state'],
    recordRes: ['Kayıt çözünürlüğü', 'Recording resolution'],
    zoomIn: ['Yakınlaş', 'Zoom in'], zoomOut: ['Uzaklaş', 'Zoom out'], zoomSet: ['Yakınlaştırma kademesi', 'Zoom level'], zoomQuery: ['Yakınlaştırmayı sorgula', 'Query zoom'],
    focusNear: ['Yakına odakla', 'Focus near'], focusFar: ['Uzağa odakla', 'Focus far'],
    ext: ['Ekran yazıları (OSD)', 'On-screen display (OSD)'], 'ext.1': ['Göster', 'Show'], 'ext.0': ['Gizle', 'Hide'], led: ['Işık', 'Light'], 'led.0': ['Kapalı', 'Off'], 'led.1': ['Açık', 'On'],
    palette: ['Renk paleti', 'Colour palette'],
    'palette.01': ['Beyaz sıcak', 'White hot'], 'palette.0B': ['Siyah sıcak', 'Black hot'], 'palette.03': ['Sepya', 'Sepia'], 'palette.04': ['Demir', 'Ironbow'], 'palette.05': ['Gökkuşağı', 'Rainbow'],
    'palette.06': ['Gece', 'Night'], 'palette.07': ['Kutup ışığı', 'Aurora'], 'palette.08': ['Kırmızı sıcak', 'Red hot'], 'palette.09': ['Orman', 'Jungle'], 'palette.0A': ['Tıbbi', 'Medical'], 'palette.0C': ['Parlak sıcak', 'Glory hot'],
    thermalScene: ['Termal sahne kipi', 'Thermal scene mode'],
    'thermalScene.00': ['Varsayılan', 'Default'], 'thermalScene.01': ['Devriye', 'Patrol'], 'thermalScene.02': ['Elle', 'Manual'], 'thermalScene.03': ['Düşük sıcaklık', 'Low temperature'],
    'thermalScene.04': ['Doğrusal', 'Linear'], 'thermalScene.05': ['Düşük karşıtlık', 'Low contrast'], 'thermalScene.06': ['Yüksek karşıtlık', 'High contrast'], 'thermalScene.07': ['Parlak ortam', 'Highlight'],
    'thermalScene.0C': ['Kurtarma', 'Rescue'], 'thermalScene.0D': ['Şehir', 'Urban'], 'thermalScene.0E': ['Sıcaklık ölçümü', 'Temperature measurement'], 'thermalScene.0F': ['Açık hava', 'Outdoors'],
    thermalTune: ['Termal görüntü ayarı', 'Thermal image tuning'], param: ['Ayar', 'Setting'], value: ['Değer', 'Value'],
    'param.TIB': ['Parlaklık', 'Brightness'], 'param.TIC': ['Karşıtlık', 'Contrast'], 'param.TDI': ['Ayrıntı', 'Detail'], 'param.TAS': ['Perde aralığı', 'Shutter interval'],
    'param.TAR': ['Uzamsal gürültü azaltma', 'Spatial noise reduction'], 'param.TTR': ['Zamansal gürültü azaltma', 'Temporal noise reduction'], 'param.TGM': ['Gama', 'Gamma'],
    laserOnce: ['Mesafe ölç', 'Measure range'],
    modelQuery: ['Modeli sorgula', 'Query model'], versionQuery: ['Sürümü sorgula', 'Query version'], sdQuery: ['Kart durumu', 'Card status'], stateQuery: ['Kamera durumu', 'Camera state'], timeSync: ['Saati eşitle', 'Sync clock'],
    raw: ['Özel komut', 'Custom command'], rawHint: ['Gövdeyi yazın (ör. #TPUG2wPTZ05); sağlama kendiliğinden eklenir.', 'Type the body (e.g. #TPUG2wPTZ05); the checksum is added automatically.'],
    's.yaw': ['Yön açısı', 'Yaw angle'], 's.pitch': ['Yükseliş açısı', 'Pitch angle'], 's.roll': ['Yatış açısı', 'Roll angle'], 's.zoom': ['Yakınlaştırma', 'Zoom'],
    's.recording': ['Karta kayıt', 'Recording to card'], 's.laser': ['Lazer mesafe (ham değer)', 'Laser range (raw value)'], 's.palette': ['Renk paleti', 'Colour palette'],
    's.camLink': ['Kamera bağlantısı', 'Camera link'], 's.sd': ['Kart (ham değerler)', 'Card (raw values)'], 's.model': ['Model', 'Model'], 's.version': ['Sürüm', 'Version'],
  };
  for (const k of Object.keys(TEXT)) if (k.startsWith('palette.')) TEXT[`e.${k}`] = TEXT[k];

  const HINT = {
    skydroidc10: ['C10: TCP 5000 · C10 Pro: UDP 5000. Akış: rtsp://192.168.144.108:554/stream=0', 'C10: TCP 5000 · C10 Pro: UDP 5000. Stream: rtsp://192.168.144.108:554/stream=0'],
    skydroidc12: ['Görünür ışık: :554/stream=1 · Termal: rtsp://192.168.144.108:555/stream=2 (termali ayrı bağlantı olarak ekleyin)', 'Visible: :554/stream=1 · Thermal: rtsp://192.168.144.108:555/stream=2 (add the thermal stream as a separate connection)'],
    skydroidc13: ['Görünür ışık: :554/stream=1 · Termal: rtsp://192.168.144.108:555/stream=2 (termali ayrı bağlantı olarak ekleyin)', 'Visible: :554/stream=1 · Thermal: rtsp://192.168.144.108:555/stream=2 (add the thermal stream as a separate connection)'],
    skydroidc20: ['Akış: rtsp://192.168.144.108:554/main (açılmazsa /stream=0). Gimbal TCP 5000, kamera TCP 8100', 'Stream: rtsp://192.168.144.108:554/main (try /stream=0 if it fails). Gimbal TCP 5000, camera TCP 8100'],
  };

  const defs = MODELS.map((m) => {
    const udp = !m.caps.c20;
    const fields = [
      { key: 'camCtrlHost', type: 'text', def: '', mono: true, span: 2 },
      { key: 'camCtrlPort', type: 'number', def: 5000, min: 1, max: 65535 },
    ];
    if (m.caps.transport) fields.push({ key: 'camTransport', type: 'select', def: 'tcp', opts: ['tcp', 'udp'] });
    if (udp) fields.push({ key: 'camLocalPort', type: 'number', def: 5000, min: 0, max: 65535 });
    if (m.caps.c20) fields.push({ key: 'camCamPort', type: 'number', def: 8100, min: 1, max: 65535 });
    fields.push({ key: 'camJoySpeed', type: 'number', def: 20, min: 1, max: 100, unit: '°/s' },
      { key: 'camAutoConnect', type: 'bool', def: true, span: 3 }, { key: 'camInvertYaw', type: 'bool', def: false, span: 3 });
    const i18n = { tr: {}, en: {} };
    ['tr', 'en'].forEach((lang, i) => {
      const d = i18n[lang];
      d[`o.model.${m.id}`] = m.name;
      d[`h.model.${m.id}`] = HINT[m.id][i];
      d[`h.camCtrlHost.${m.id}`] = i ? 'Empty = same as the video (RTSP) address. Factory default 192.168.144.108' : 'Boşsa görüntü (RTSP) adresi kullanılır. Fabrika çıkışı 192.168.144.108';
      d[`h.camCtrlPort.${m.id}`] = i ? 'Default 5000' : 'Varsayılan 5000';
      d[`h.camLocalPort.${m.id}`] = i ? 'UDP: default 5000 (the Skydroid app on the same PC also uses it); 0 = automatic' : 'UDP: varsayılan 5000 (aynı bilgisayardaki Skydroid uygulaması da bu portu kullanır); 0 = otomatik';
      if (m.caps.transport) d[`h.camTransport.${m.id}`] = i ? 'C10: TCP · C10 Pro: UDP' : 'C10: TCP · C10 Pro: UDP';
      if (m.caps.c20) d[`h.camCamPort.${m.id}`] = i ? 'Zoom, focus, photo and recording (TCP); default 8100' : 'Yakınlaştırma, odak, fotoğraf ve kayıt (TCP); varsayılan 8100';
      for (const [k, v] of Object.entries(TEXT)) d[`cam.${m.id}.${k}`] = v[i];
    });
    return {
      id: m.id, name: m.name, vendor: 'Skydroid',
      defaults: { host: '192.168.144.108', port: 554, path: m.path, rtspTransport: 'tcp' },
      fields, panel: panel(m.caps), status: status(m.caps), i18n,
    };
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = defs;
  else { root.CAMERA_MODELS = root.CAMERA_MODELS || {}; for (const d of defs) root.CAMERA_MODELS[d.id] = d; }
})(typeof self !== 'undefined' ? self : this);
