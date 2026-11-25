// Dron "Ayarlar" modülünün tanımları: aracın temel uçuş ayarları, uzman olmayan kullanıcının anlayacağı dille.
// Her ayar bir ya da birkaç gerçek parametreye bağlanır (ArduPilot / PX4); birim dönüşümleri (m/s ↔ cm/s,
// ° ↔ santiderece, s ↔ ms) ve bir ayarın gerektirdiği ek parametre yazımları (linked) burada tutulur.
// Yalnızca veri ve saf işlevler: DOM yok. Hem Node'da (require) hem pencerede (window.TUNING) çalışır.
// Bütün metinler { tr, en } biçimindedir; arayüz Türkçe ise tr, değilse en gösterilir (bkz. text()).
(function (root) {
  'use strict';

  const L = (tr, en) => ({ tr, en });
  const COPTER = ['copter', 'heli'];
  const PLANE = ['plane', 'vtol'];

  // Parametre eşlemesi kısaltmaları: parametre = değer × scale + offset
  const p = (name, scale = 1, extra = {}) => ({ name, scale, offset: 0, ...extra });
  const pi = (name, scale = 1) => p(name, scale, { round: true }); // tamsayı parametre
  const ap = (params, extra = {}) => ({ fw: 'ardupilot', params: [].concat(params), ...extra });
  const cop = (params, extra = {}) => ap(params, { vehicles: COPTER, ...extra });
  const plane = (params, extra = {}) => ap(params, { vehicles: PLANE, ...extra });
  const rover = (params, extra = {}) => ap(params, { vehicles: ['rover'], ...extra });
  const px4 = (params, extra = {}) => ({ fw: 'px4', params: [].concat(params), ...extra });
  const px4mc = (params, extra = {}) => px4(params, { vehicles: ['copter'], ...extra });
  const o = (value, tr, en, noteTr, noteEn) => ({ value, label: L(tr, en), ...(noteTr ? { note: L(noteTr, noteEn || noteTr) } : {}) });

  // ---- Arayüz metinleri (i18n sözlüklerine eklenmez; modül kendi içinde taşır) ----
  const UI = {
    search: L('Ayarlarda ara…', 'Search settings…'),
    needParams: L('Ayarlar aracın parametrelerinden okunur', 'Settings are read from the vehicle parameters'),
    needParamsSub: L('Araçtaki değerleri görmek ve değiştirmek için önce parametreleri okuyun.', 'Read the parameters first to see and change the values on the vehicle.'),
    readParams: L('Parametreleri oku', 'Read parameters'),
    reading: L('Parametreler okunuyor… {n} / {total}', 'Reading parameters… {n} / {total}'),
    notLinked: L('Araç bağlı değil. Bağlandığınızda ayarlar burada görünür.', 'The vehicle is not connected. Settings appear here once it is.'),
    none: L('Bu araçta desteklenen bir ayar bulunamadı.', 'No supported setting was found on this vehicle.'),
    noMatch: L('Aramayla eşleşen ayar yok.', 'No setting matches the search.'),
    results: L('Arama sonuçları', 'Search results'),
    changed: L('değişti', 'changed'),
    apply: L('Uygula', 'Apply'),
    revert: L('Geri al', 'Revert'),
    applyAll: L('Tümünü uygula', 'Apply all'),
    discard: L('Vazgeç', 'Discard'),
    nChanged: L('{n} ayar değişti', '{n} settings changed'),
    nWrites: L('{n} parametre yazılacak', '{n} parameters will be written'),
    willChange: L('Değişecek parametreler', 'Parameters that will change'),
    bound: L('Bağlı parametreler', 'Underlying parameters'),
    noWrites: L('Araçtaki değerler zaten böyle; yazılacak parametre yok.', 'The vehicle already has these values; nothing to write.'),
    applied: L('Ayar uygulandı', 'Setting applied'),
    appliedN: L('{n} parametre yazıldı', '{n} parameters written'),
    failedParams: L('Yazılamayan parametreler', 'Parameters that could not be written'),
    on: L('Açık', 'On'),
    off: L('Kapalı', 'Off'),
    custom: L('Özel', 'Custom'),
    customNote: L('Değerler hazır karakterlerden hiçbiriyle birebir eşleşmiyor.', 'The values do not match any of the presets exactly.'),
    riskTitle: L('Güvenliği etkileyen değişiklik', 'Safety-relevant change'),
    riskAsk: L('Yine de uygulamak istiyor musunuz?', 'Do you still want to apply it?'),
    perCell: L('hücre başına', 'per cell'),
    ofCapacity: L('kapasitenin', 'of capacity'),
    ground: L('yer', 'ground'),
    position: L('konum', 'position'),
    linkedWhy: L('Bağlı değişiklik', 'Linked change'),
    busy: L('Yazılıyor…', 'Writing…'),
    kmh: L('≈ {n} km/sa', '≈ {n} km/h'),
    turn: L('bir tam tur ≈ {n} sn', 'one full turn ≈ {n} s'),
    cellInfo: L('{n} V/hücre · {c} hücre', '{n} V/cell · {c} cells'),
    pctCapacity: L('kapasitenin %{n}', '{n} % of capacity'),
    pwmBand: L('kanal sinyali {n}', 'channel signal {n}'),
    home: L('ev', 'home'),
    notInList: L('araçtaki değer', 'value on the vehicle'),
  };

  // ---- Seçenek listeleri ----
  // ArduCopter kumanda / yer istasyonu kaybı ve batarya eylemleri (sürüm 4.x)
  const COPTER_BATT_ACT = [
    o(0, 'Hiçbir şey yapma', 'Do nothing', 'Yalnızca uyarı verilir', 'Only a warning is given'),
    o(1, 'İn', 'Land', 'Bulunduğu yere iner', 'Lands where it is'),
    o(2, 'Eve dön (RTL)', 'Return home (RTL)'),
    o(3, 'Akıllı eve dönüş, olmazsa RTL', 'SmartRTL, else RTL', 'Geldiği yoldan geri döner', 'Returns along the path it came'),
    o(4, 'Akıllı eve dönüş, olmazsa in', 'SmartRTL, else Land'),
    o(5, 'Motorları durdur', 'Terminate', 'Tehlikeli: araç düşer', 'Dangerous: the vehicle falls'),
    o(6, 'Görevdeki iniş rotasına git, yoksa RTL', 'Mission landing sequence, else RTL'),
    o(7, 'Frenle, olmazsa in', 'Brake, else Land'),
  ];

  const lowActRisk = (v) => (v === 0 ? L('Batarya koruması devre dışı kalır: batarya bitse bile araç kendiliğinden inmez ya da dönmez.', 'Battery protection is disabled: the vehicle will not land or return by itself even when the battery runs out.') : v === 5 ? L('"Motorları durdur" seçeneği havadaki aracı düşürür.', '"Terminate" makes an airborne vehicle fall.') : null);

  // ---- Gruplar ve ayarlar ----
  const GROUPS = [
    // ============================== HIZ ==============================
    {
      id: 'speed', icon: 'gauge', title: L('Hız', 'Speed'),
      intro: L('Aracın otomatik görevlerde ve elle uçuşta ne kadar hızlı gideceğini, ne kadar çabuk hızlanacağını ve en çok ne kadar yatabileceğini belirler. Emin değilseniz önce "Uçuş karakteri"nden hazır bir takım seçin, sonra tek tek ince ayar yapın.', 'Controls how fast the vehicle flies in automatic missions and in manual flight, how quickly it accelerates and how far it may lean. If unsure, pick a ready-made "Flight character" first and fine-tune afterwards.'),
      settings: [
        {
          id: 'flightStyle', kind: 'preset', gauge: null, wide: true,
          title: L('Uçuş karakteri', 'Flight character'),
          desc: L('Hız, ivme ve yatış açısını birbirine uyumlu bir takım olarak tek seferde ayarlar. Sakin: çekim ve eğitim için yumuşak ve yavaş. Normal: fabrika değerleri. Hızlı ve Çok hızlı: geniş ve açık alanda, deneyimli pilot için; batarya daha çabuk biter ve durma mesafesi uzar.', 'Sets speed, acceleration and lean angle together as one consistent bundle. Calm: soft and slow, for filming and training. Normal: factory values. Fast and Very fast: for open areas and experienced pilots; the battery drains faster and stopping distance grows.'),
          options: [
            o('calm', 'Sakin', 'Calm', '5 m/s · 20° yatış', '5 m/s · 20° lean'),
            o('normal', 'Normal', 'Normal', '10 m/s · 30° yatış', '10 m/s · 30° lean'),
            o('fast', 'Hızlı', 'Fast', '15 m/s · 40° yatış', '15 m/s · 40° lean'),
            o('veryfast', 'Çok hızlı', 'Very fast', '20 m/s · 45° yatış', '20 m/s · 45° lean'),
          ],
          map: [
            cop(['WPNAV_SPEED'], { bundles: {
              calm: { WPNAV_SPEED: 500, WPNAV_SPEED_UP: 150, WPNAV_SPEED_DN: 100, WPNAV_ACCEL: 100, LOIT_SPEED: 500, LOIT_ACC_MAX: 250, ANGLE_MAX: 2000, PILOT_SPEED_UP: 150 },
              normal: { WPNAV_SPEED: 1000, WPNAV_SPEED_UP: 250, WPNAV_SPEED_DN: 150, WPNAV_ACCEL: 250, LOIT_SPEED: 1250, LOIT_ACC_MAX: 500, ANGLE_MAX: 3000, PILOT_SPEED_UP: 250 },
              fast: { WPNAV_SPEED: 1500, WPNAV_SPEED_UP: 400, WPNAV_SPEED_DN: 250, WPNAV_ACCEL: 400, LOIT_SPEED: 2000, LOIT_ACC_MAX: 700, ANGLE_MAX: 4000, PILOT_SPEED_UP: 400 },
              veryfast: { WPNAV_SPEED: 2000, WPNAV_SPEED_UP: 500, WPNAV_SPEED_DN: 300, WPNAV_ACCEL: 500, LOIT_SPEED: 2500, LOIT_ACC_MAX: 900, ANGLE_MAX: 4500, PILOT_SPEED_UP: 500 },
            } }),
            px4mc(['MPC_XY_CRUISE'], {
              options: [
                o('calm', 'Sakin', 'Calm', '3 m/s · 20° yatış', '3 m/s · 20° lean'),
                o('normal', 'Normal', 'Normal', '5 m/s · 45° yatış', '5 m/s · 45° lean'),
                o('fast', 'Hızlı', 'Fast', '10 m/s · 55° yatış', '10 m/s · 55° lean'),
                o('veryfast', 'Çok hızlı', 'Very fast', '15 m/s · 65° yatış', '15 m/s · 65° lean'),
              ],
              bundles: {
                calm: { MPC_XY_CRUISE: 3, MPC_XY_VEL_MAX: 5, MPC_VEL_MANUAL: 5, MPC_Z_VEL_MAX_UP: 1.5, MPC_Z_VEL_MAX_DN: 1, MPC_TILTMAX_AIR: 20, MPC_ACC_HOR: 2 },
                normal: { MPC_XY_CRUISE: 5, MPC_XY_VEL_MAX: 12, MPC_VEL_MANUAL: 10, MPC_Z_VEL_MAX_UP: 3, MPC_Z_VEL_MAX_DN: 1.5, MPC_TILTMAX_AIR: 45, MPC_ACC_HOR: 3 },
                fast: { MPC_XY_CRUISE: 10, MPC_XY_VEL_MAX: 15, MPC_VEL_MANUAL: 15, MPC_Z_VEL_MAX_UP: 5, MPC_Z_VEL_MAX_DN: 2.5, MPC_TILTMAX_AIR: 55, MPC_ACC_HOR: 5 },
                veryfast: { MPC_XY_CRUISE: 15, MPC_XY_VEL_MAX: 20, MPC_VEL_MANUAL: 20, MPC_Z_VEL_MAX_UP: 8, MPC_Z_VEL_MAX_DN: 4, MPC_TILTMAX_AIR: 65, MPC_ACC_HOR: 8 },
              },
            }),
          ],
        },
        {
          id: 'missionSpeed', kind: 'number', unit: 'm/s', min: 0.5, max: 20, step: 0.5, gauge: 'speed',
          title: L('Görev hızı (yatay)', 'Mission speed (horizontal)'),
          desc: L('Otomatik görevde ve "noktaya git" komutunda aracın noktalar arasındaki yatay hızıdır. Çoğu araç için 5–10 m/s uygundur. Yükseltirseniz görev kısalır ama batarya daha çabuk biter, dönüşler genişler ve durma mesafesi uzar; düşürürseniz çekim ve haritalama daha düzgün olur.', 'The horizontal speed between waypoints in automatic missions and "go to" commands. 5–10 m/s suits most vehicles. Raising it shortens the mission but drains the battery faster, widens turns and lengthens the stopping distance; lowering it gives smoother footage and mapping.'),
          map: [
            cop(pi('WPNAV_SPEED', 100), { linked: (v, get) => {
              const out = [];
              const acc = get('WPNAV_ACCEL');
              const need = Math.min(500, Math.round((v * 100) / 4));
              if (acc !== undefined && acc < need) out.push({ name: 'WPNAV_ACCEL', value: need, why: L('Araç bu hıza makul sürede (yaklaşık 4 saniyede) ulaşabilsin diye yatay ivme de yükseltilir; yoksa kısa bacaklarda hedef hıza hiç çıkamaz.', 'Horizontal acceleration is raised too so the vehicle can reach this speed in reasonable time (about 4 s); otherwise it never gets there on short legs.') });
              const ang = get('ANGLE_MAX');
              if (v > 15 && ang !== undefined && ang < 3000) out.push({ name: 'ANGLE_MAX', value: 3000, why: L('15 m/s üstü hızlar için araç en az 30° yatabilmelidir; daha küçük yatış açısıyla bu hıza ulaşamaz.', 'Speeds above 15 m/s need at least 30° of lean; with a smaller lean limit the vehicle cannot reach them.') });
              return out;
            } }),
            px4mc(p('MPC_XY_CRUISE'), { min: 3, linked: (v, get) => {
              const max = get('MPC_XY_VEL_MAX');
              return max !== undefined && max < v ? [{ name: 'MPC_XY_VEL_MAX', value: v, why: L('Görev hızı, izin verilen en yüksek yatay hızı aşamaz; bu yüzden üst sınır da yükseltilir.', 'Mission speed cannot exceed the maximum allowed horizontal speed, so that limit is raised as well.') }] : [];
            } }),
            plane(p('AIRSPEED_CRUISE'), { min: 5, max: 50 }),
            plane(pi('TRIM_ARSPD_CM', 100), { min: 5, max: 50 }),
            rover(p('WP_SPEED'), { min: 0, max: 20, step: 0.1, zero: L('0: seyir hızı (CRUISE_SPEED) kullanılır', '0: cruise speed (CRUISE_SPEED) is used') }),
          ],
        },
        {
          id: 'missionClimb', kind: 'number', unit: 'm/s', min: 0.5, max: 10, step: 0.1, gauge: 'speed', dir: 'up',
          title: L('Görevde tırmanma hızı', 'Mission climb speed'),
          desc: L('Otomatik uçuşta (görev, kalkış, eve dönüş) aracın yükselme hızıdır. Tipik değer 2,5 m/s. Çok yüksek seçerseniz ağır yüklü araçta motorlar sınıra dayanır ve denge bozulabilir.', 'How fast the vehicle climbs in automatic flight (mission, takeoff, return). Typically 2.5 m/s. Too high a value pushes the motors of a heavy vehicle to their limit and can upset stability.'),
          map: [
            cop(pi('WPNAV_SPEED_UP', 100)),
            px4mc(p('MPC_Z_V_AUTO_UP'), { max: 8, linked: (v, get) => {
              const max = get('MPC_Z_VEL_MAX_UP');
              return max !== undefined && max < v ? [{ name: 'MPC_Z_VEL_MAX_UP', value: v, why: L('Otomatik tırmanma hızı, en yüksek tırmanma hızını aşamaz; üst sınır da yükseltilir.', 'Automatic climb speed cannot exceed the maximum climb speed, so that limit is raised too.') }] : [];
            } }),
          ],
        },
        {
          id: 'missionDescent', kind: 'number', unit: 'm/s', min: 0.3, max: 5, step: 0.1, gauge: 'speed', dir: 'down',
          title: L('Görevde alçalma hızı', 'Mission descent speed'),
          desc: L('Otomatik uçuşta aracın alçalma hızıdır. Tipik değer 1,5 m/s. Çok hızlı alçalan çok rotorlu araç kendi pervane akımının içine girip sallanmaya başlayabilir; bu yüzden 3 m/s üstüne dikkatle çıkın.', 'How fast the vehicle descends in automatic flight. Typically 1.5 m/s. A multirotor descending too fast can sink into its own propwash and start wobbling, so go above 3 m/s with care.'),
          map: [
            cop(pi('WPNAV_SPEED_DN', 100)),
            px4mc(p('MPC_Z_V_AUTO_DN'), { min: 0.5, max: 4, linked: (v, get) => {
              const max = get('MPC_Z_VEL_MAX_DN');
              return max !== undefined && max < v ? [{ name: 'MPC_Z_VEL_MAX_DN', value: v, why: L('Otomatik alçalma hızı, en yüksek alçalma hızını aşamaz; üst sınır da yükseltilir.', 'Automatic descent speed cannot exceed the maximum descent speed, so that limit is raised too.') }] : [];
            } }),
          ],
        },
        {
          id: 'loiterSpeed', kind: 'number', unit: 'm/s', min: 0.5, max: 35, step: 0.5, gauge: 'speed',
          title: L('Elle uçuşta en yüksek hız', 'Top speed in manual flight'),
          desc: L('Konum tutmalı kipte (Loiter / Position) çubuğu sonuna kadar ittiğinizde aracın ulaşacağı en yüksek yatay hızdır. Yeni başlayanlar için 5 m/s rahat bir değerdir; fabrika değeri 12,5 m/s kadardır. Bıraktığınızda araç bu hızdan frenleyeceği için yüksek değerlerde durma mesafesi uzar.', 'The top horizontal speed with the stick fully deflected in position-holding modes (Loiter / Position). 5 m/s is comfortable for beginners; the factory value is about 12.5 m/s. The vehicle brakes from this speed when you let go, so stopping distance grows with it.'),
          map: [cop(pi('LOIT_SPEED', 100)), px4mc(p('MPC_VEL_MANUAL'), { min: 3, max: 20 })],
        },
        {
          id: 'pilotClimb', kind: 'number', unit: 'm/s', min: 0.5, max: 5, step: 0.1, gauge: 'speed', dir: 'up',
          title: L('Elle uçuşta tırmanma hızı', 'Pilot climb speed'),
          desc: L('İrtifa tutmalı kiplerde gaz çubuğu en üstteyken aracın yükselme hızıdır. Tipik değer 2,5 m/s. Düşük değer kumandayı daha yumuşak ve bağışlayıcı yapar.', 'How fast the vehicle climbs with the throttle stick fully up in altitude-holding modes. Typically 2.5 m/s. A lower value makes the controls gentler and more forgiving.'),
          map: [cop(pi('PILOT_SPEED_UP', 100)), px4mc(p('MPC_Z_VEL_MAX_UP'), { max: 8 })],
        },
        {
          id: 'pilotDescent', kind: 'number', unit: 'm/s', min: 0, max: 5, step: 0.1, gauge: 'speed', dir: 'down',
          zero: L('0: tırmanma hızıyla aynı değer kullanılır', '0: the same value as the climb speed is used'),
          title: L('Elle uçuşta alçalma hızı', 'Pilot descent speed'),
          desc: L('İrtifa tutmalı kiplerde gaz çubuğu en alttayken aracın alçalma hızıdır. 0 bırakırsanız tırmanma hızıyla aynı olur. Yere yakın uçuşta düşük tutmak sert inişleri önler.', 'How fast the vehicle descends with the throttle stick fully down in altitude-holding modes. Leave at 0 to use the climb speed. Keeping it low prevents hard landings when flying close to the ground.'),
          map: [cop(pi('PILOT_SPEED_DN', 100)), px4mc(p('MPC_Z_VEL_MAX_DN'), { min: 0.5, max: 4, zero: null })],
        },
        {
          id: 'horizAccel', kind: 'number', unit: 'm/s²', min: 0.5, max: 5, step: 0.1, gauge: 'bar',
          ends: [L('Yumuşak', 'Gentle'), L('Atak', 'Aggressive')],
          title: L('Görevde hızlanma (ivme)', 'Mission acceleration'),
          desc: L('Otomatik uçuşta aracın ne kadar çabuk hızlanıp yavaşlayacağını belirler. Tipik değer 2,5 m/s². Düşük değer yumuşak kalkış-duruş ve geniş dönüşler, yüksek değer keskin ve sert hareketler demektir.', 'How quickly the vehicle speeds up and slows down in automatic flight. Typically 2.5 m/s². Low values give soft starts and stops and wide turns, high values sharp and abrupt moves.'),
          map: [cop(pi('WPNAV_ACCEL', 100)), px4mc(p('MPC_ACC_HOR'), { min: 2, max: 15 })],
        },
        {
          id: 'loiterAccel', kind: 'number', unit: 'm/s²', min: 1, max: 9.8, step: 0.1, gauge: 'bar',
          ends: [L('Yumuşak', 'Gentle'), L('Atak', 'Aggressive')],
          title: L('Elle uçuşta hızlanma (ivme)', 'Manual-flight acceleration'),
          desc: L('Konum tutmalı kipte (Loiter) çubuğa verdiğiniz komuta aracın ne kadar çabuk tepki vereceğini belirler. Tipik değer 5 m/s². Düşürürseniz araç ağır ve yumuşak, yükseltirseniz çevik ama sarsıntılı hisseder.', 'How quickly the vehicle responds to the stick in the position-holding mode (Loiter). Typically 5 m/s². Lower feels heavy and smooth, higher feels agile but jerky.'),
          map: [cop(pi('LOIT_ACC_MAX', 100))],
        },
        {
          id: 'maxLean', kind: 'number', unit: '°', min: 10, max: 80, step: 1, gauge: 'angle',
          title: L('En büyük yatış açısı', 'Maximum lean angle'),
          desc: L('Aracın bütün kiplerde öne-arkaya ve sağa-sola en çok kaç derece yatabileceğini sınırlar. Tipik değer 30°. Küçük açı aracı sakinleştirir ama en yüksek hızı ve rüzgâra dayanma gücünü düşürür; 45° üstü yalnızca güçlü araçlar ve deneyimli pilotlar içindir.', 'Limits how far the vehicle may lean forward-back and left-right in all modes. Typically 30°. A small angle calms the vehicle but lowers top speed and wind resistance; above 45° is for powerful vehicles and experienced pilots only.'),
          map: [cop(pi('ANGLE_MAX', 100)), px4mc(p('MPC_TILTMAX_AIR'), { min: 20, max: 89 }), plane(p('ROLL_LIMIT_DEG'), { min: 10, max: 80 }), plane(pi('LIM_ROLL_CD', 100), { min: 10, max: 80 })],
        },
        {
          id: 'autoYawRate', kind: 'number', unit: '°/s', min: 5, max: 180, step: 5, gauge: 'rate',
          title: L('Otomatik uçuşta dönüş hızı', 'Yaw speed in automatic flight'),
          desc: L('Otomatik kiplerde aracın burnunu yeni yöne saniyede kaç derece çevireceğini sınırlar. Tipik değer 60 °/s. Düşük değer çekimde yumuşak dönüş sağlar; çok yüksek değer aracı sarsar.', 'Limits how many degrees per second the nose turns to a new heading in automatic modes. Typically 60 °/s. A low value gives smooth pans on video; a very high one jolts the vehicle.'),
          map: [cop(pi('ATC_SLEW_YAW', 100)), px4mc(p('MPC_YAWRAUTO_MAX'), { min: 5, max: 360 })],
        },
        {
          id: 'yawBehavior', kind: 'select', gauge: null,
          title: L('Görevde burun yönü', 'Nose direction during missions'),
          desc: L('Otomatik görevde aracın burnunun nereye bakacağını seçer. Kamera öne bakıyorsa "sonraki noktaya bak" en doğal sonucu verir; burun yönünü kendiniz yönetmek istiyorsanız "değiştirme" seçin.', 'Chooses where the nose points during automatic missions. With a forward-facing camera "face the next waypoint" looks most natural; choose "never change" to control the heading yourself.'),
          options: [
            o(0, 'Değiştirme', 'Never change', 'Burun yönünü pilot belirler', 'The pilot controls the heading'),
            o(1, 'Sonraki noktaya bak', 'Face next waypoint'),
            o(2, 'Sonraki noktaya bak (eve dönüş hariç)', 'Face next waypoint except RTL'),
            o(3, 'Gidiş yönüne bak', 'Face along the GPS course'),
          ],
          map: [cop(pi('WP_YAW_BEHAVIOR'))],
        },
        {
          id: 'wpRadius', kind: 'number', unit: 'm', min: 0.1, max: 10, step: 0.1, gauge: 'bar',
          ends: [L('Tam üstünden', 'Exact'), L('Geniş', 'Wide')],
          title: L('Noktaya varış yarıçapı', 'Waypoint radius'),
          desc: L('Araç görev noktasına bu kadar yaklaşınca nokta "varıldı" sayılır ve sıradakine geçilir. Tipik değer 2 m. Büyük değer köşeleri yuvarlar ve görevi akıcı yapar; küçük değer noktaların tam üstünden geçirir ama araç her noktada yavaşlar.', 'A waypoint counts as reached once the vehicle is this close, and it moves on to the next. Typically 2 m. A large value rounds corners and keeps the mission flowing; a small one passes right over the points but slows down at each.'),
          map: [cop(pi('WPNAV_RADIUS', 100)), px4mc(p('NAV_ACC_RAD'), { min: 0.1, max: 50 }), rover(p('WP_RADIUS'), { min: 0.1, max: 20 })],
        },
      ],
    },

    // ============================== KALKIŞ ==============================
    {
      id: 'takeoff', icon: 'takeoff', title: L('Kalkış', 'Takeoff'),
      intro: L('Aracın yerden nasıl ayrılacağını belirler: kalkışta çıkacağı yükseklik, motorların devir alma süresi ve yerden kesilirken yatay hareketin ne zaman başlayacağı.', 'Controls how the vehicle leaves the ground: the height it climbs to, how long the motors take to spool up and when horizontal movement may begin.'),
      settings: [
        {
          id: 'takeoffAlt', kind: 'number', unit: 'm', min: 0, max: 10, step: 0.5, gauge: 'altitude',
          zero: L('0: kendiliğinden kalkış yok; gazı siz verirsiniz', '0: no automatic takeoff; you raise the throttle yourself'),
          title: L('Kalkış yüksekliği', 'Takeoff altitude'),
          desc: L('İrtifa tutmalı kiplerde gaz çubuğunu ortanın üstüne aldığınızda aracın kendiliğinden yükseleceği yüksekliktir. 0 bırakırsanız araç yalnızca çubuğa verdiğiniz kadar yükselir. 1–2 m, yer etkisinden çabuk kurtulmak için iyi bir değerdir.', 'The height the vehicle climbs to by itself when you raise the throttle above the middle in altitude-holding modes. At 0 it only climbs as much as you command. 1–2 m is a good value to clear ground effect quickly.'),
          map: [
            cop(pi('PILOT_TKOFF_ALT', 100)),
            px4(p('MIS_TAKEOFF_ALT'), { max: 80, zero: null, desc: L('"Kalkış" komutunda aracın yükseleceği en düşük yüksekliktir. Tipik değer 2,5 m. Çevrede engel varsa, engellerin üstünde kalacak kadar yükseltin.', 'The minimum height the vehicle climbs to on a "takeoff" command. Typically 2.5 m. Raise it enough to clear nearby obstacles.') }),
            plane(p('TKOFF_ALT'), { max: 255, step: 1, zero: null, desc: L('Otomatik kalkışta uçağın tırmanacağı yüksekliktir; bu yüksekliğe ulaşınca kalkış tamamlanmış sayılır. Tipik değer 50 m. Çevredeki ağaç ve binaların üstünde kalacak kadar yüksek seçin.', 'The altitude the plane climbs to in an automatic takeoff; reaching it completes the takeoff. Typically 50 m. Choose it high enough to clear surrounding trees and buildings.') }),
          ],
        },
        {
          id: 'navAltMin', kind: 'number', unit: 'm', min: 0, max: 5, step: 0.1, gauge: 'altitude',
          zero: L('0: sınır yok, yatay düzeltme yerden itibaren serbest', '0: no limit, horizontal correction is allowed from the ground'),
          title: L('Yatay harekete başlama yüksekliği', 'Height before moving sideways'),
          desc: L('Otomatik kalkışta araç bu yüksekliğe ulaşana kadar yalnızca dik yükselir, yana doğru düzeltme yapmaz; inişte de bu yüksekliğin altında yatay düzeltme bırakılır. Uzun ayaklı ya da devrilmeye yatkın araçlarda 1–2 m vermek kalkışta takla atmayı önler.', 'During an automatic takeoff the vehicle only climbs straight up until it reaches this height, with no sideways correction; on landing, correction stops below it. 1–2 m helps tall or tip-prone vehicles avoid flipping on takeoff.'),
          map: [cop(p('WP_NAVALT_MIN'))],
        },
        {
          id: 'takeoffSpeed', kind: 'number', unit: 'm/s', min: 1, max: 5, step: 0.1, gauge: 'speed', dir: 'up',
          title: L('Kalkış hızı', 'Takeoff speed'),
          desc: L('Otomatik kalkışta aracın yerden yükselme hızıdır. Tipik değer 1,5 m/s. Yüksek değer aracı yerden çabuk uzaklaştırır ama kalkışı sertleştirir.', 'How fast the vehicle rises from the ground in an automatic takeoff. Typically 1.5 m/s. A high value clears the ground quickly but makes the takeoff more abrupt.'),
          map: [px4mc(p('MPC_TKO_SPEED'))],
        },
        {
          id: 'takeoffSlew', kind: 'number', unit: 's', min: 0.25, max: 5, step: 0.05, gauge: 'time',
          title: L('Kalkışta gaz verme süresi', 'Takeoff throttle ramp'),
          desc: L('Kalkışta gazın sıfırdan tam değerine kaç saniyede çıkacağını belirler. Tipik değer 2 s. Süreyi uzatmak kalkışı yumuşatır ve büyük pervaneli araçlarda ani sıçramayı önler; çok uzun tutarsanız araç yerde sürüklenebilir.', 'How many seconds the throttle takes to ramp from zero to full at takeoff. Typically 2 s. A longer ramp softens the takeoff and prevents a sudden jump on large-prop vehicles; too long and the vehicle may drag along the ground.'),
          map: [cop(p('TKOFF_SLEW_TIME')), px4mc(p('MPC_TKO_RAMP_T'), { min: 0, max: 5, step: 0.1 })],
        },
        {
          id: 'spoolTime', kind: 'number', unit: 's', min: 0.05, max: 2, step: 0.05, gauge: 'time',
          title: L('Motorların devir alma süresi', 'Motor spool-up time'),
          desc: L('Motorlar kurulduktan sonra rölantiden uçuş devrine kaç saniyede çıkacağını belirler. Tipik değer 0,5 s. Büyük ve ağır pervanelerde süreyi uzatmak ESC senkron kaybını ve sarsıntılı kalkışı önler.', 'How many seconds the motors take to go from idle to flight speed after arming. Typically 0.5 s. With large, heavy props a longer time prevents ESC desync and a jerky takeoff.'),
          map: [cop(p('MOT_SPOOL_TIME'))],
        },
        {
          id: 'groundEffect', kind: 'toggle', gauge: null,
          title: L('Yer etkisi düzeltmesi', 'Ground-effect compensation'),
          desc: L('Yere çok yakınken pervane havası barometreyi yanıltır ve araç kalkış-inişte zıplayabilir. Açıkken uçuş kontrolcüsü bu sırada barometreye daha az güvenir. Açık bırakmanız önerilir.', 'Very close to the ground the prop wash fools the barometer and the vehicle may bounce on takeoff and landing. When on, the flight controller trusts the barometer less during those moments. Leaving it on is recommended.'),
          map: [cop(p('GND_EFFECT_COMP', 1, { on: 1, off: 0 }))],
        },
      ],
    },

    // ============================== İNİŞ ==============================
    {
      id: 'landing', icon: 'land', title: L('İniş', 'Landing'),
      intro: L('İnişin ne kadar yumuşak olacağını ve araç yere değdikten sonra motorların ne zaman duracağını belirler. İniş iki aşamadır: önce hızlı alçalma, yere yaklaşınca yavaş son yaklaşma.', 'Controls how soft the landing is and when the motors stop after touchdown. Landing has two stages: a faster descent, then a slow final approach close to the ground.'),
      settings: [
        {
          id: 'landStyle', kind: 'preset', gauge: null, wide: true,
          title: L('İniş karakteri', 'Landing character'),
          desc: L('İnişin iki aşamasını birlikte ayarlar. Yumuşak: hassas yük ve kamera için, iniş uzun sürer. Normal: fabrika değerleri. Hızlı: rüzgârlı havada ya da batarya azken yerde daha çabuk olmak için; teker ve ayaklara daha çok yük biner.', 'Sets both landing stages together. Soft: for delicate payloads and cameras, takes longer. Normal: factory values. Fast: to get down sooner in wind or on low battery; puts more load on the landing gear.'),
          options: [
            o('soft', 'Yumuşak iniş', 'Soft landing', '0,3 m/s · son 15 m yavaş', '0.3 m/s · slow for the last 15 m'),
            o('normal', 'Normal iniş', 'Normal landing', '0,5 m/s · son 10 m yavaş', '0.5 m/s · slow for the last 10 m'),
            o('fast', 'Hızlı iniş', 'Fast landing', '0,8 m/s · son 7 m yavaş', '0.8 m/s · slow for the last 7 m'),
          ],
          map: [
            cop(['LAND_SPEED'], { bundles: {
              soft: { LAND_SPEED: 30, LAND_SPEED_HIGH: 100, LAND_ALT_LOW: 1500 },
              normal: { LAND_SPEED: 50, LAND_SPEED_HIGH: 0, LAND_ALT_LOW: 1000 },
              fast: { LAND_SPEED: 80, LAND_SPEED_HIGH: 250, LAND_ALT_LOW: 700 },
            } }),
            px4mc(['MPC_LAND_SPEED'], {
              options: [
                o('soft', 'Yumuşak iniş', 'Soft landing', '0,6 m/s · son 8 m yavaş', '0.6 m/s · slow for the last 8 m'),
                o('normal', 'Normal iniş', 'Normal landing', '0,7 m/s · son 5 m yavaş', '0.7 m/s · slow for the last 5 m'),
                o('fast', 'Hızlı iniş', 'Fast landing', '1 m/s · son 3 m yavaş', '1 m/s · slow for the last 3 m'),
              ],
              bundles: {
                soft: { MPC_LAND_SPEED: 0.6, MPC_LAND_ALT1: 15, MPC_LAND_ALT2: 8 },
                normal: { MPC_LAND_SPEED: 0.7, MPC_LAND_ALT1: 10, MPC_LAND_ALT2: 5 },
                fast: { MPC_LAND_SPEED: 1, MPC_LAND_ALT1: 8, MPC_LAND_ALT2: 3 },
              },
            }),
          ],
        },
        {
          id: 'landSpeed', kind: 'number', unit: 'm/s', min: 0.3, max: 2, step: 0.05, gauge: 'speed', dir: 'down',
          title: L('Yere değme hızı', 'Touchdown speed'),
          desc: L('İnişin son aşamasında, yere değene kadarki alçalma hızıdır. Tipik değer 0,5 m/s. Düşürürseniz iniş yumuşar ama uzar ve rüzgârda araç sürüklenebilir; 1 m/s üstü sert iniş demektir.', 'The descent speed in the final stage of landing, until touchdown. Typically 0.5 m/s. Lower is softer but takes longer and lets the wind push the vehicle; above 1 m/s is a hard landing.'),
          map: [cop(pi('LAND_SPEED', 100)), px4mc(p('MPC_LAND_SPEED'), { min: 0.6, max: 2 })],
        },
        {
          id: 'landSpeedHigh', kind: 'number', unit: 'm/s', min: 0, max: 5, step: 0.1, gauge: 'speed', dir: 'down',
          zero: L('0: görevdeki alçalma hızı kullanılır', '0: the mission descent speed is used'),
          title: L('İnişin ilk aşama hızı', 'First-stage landing speed'),
          desc: L('İnişin yüksekteki ilk bölümünde, yavaş son yaklaşma başlayana kadar kullanılan alçalma hızıdır. 0 bırakırsanız "Görevde alçalma hızı" kullanılır. Yüksekten yapılan inişleri kısaltmak için yükseltebilirsiniz.', 'The descent speed in the upper part of the landing, until the slow final approach begins. At 0 the "Mission descent speed" is used. Raise it to shorten landings from high up.'),
          map: [cop(pi('LAND_SPEED_HIGH', 100))],
        },
        {
          id: 'landSlowStart', kind: 'number', unit: 'm', min: 0, max: 122, step: 1, gauge: 'altitude',
          title: L('Yavaşlamaya başlama yüksekliği', 'Slow-down start height'),
          desc: L('Araç inerken bu yüksekliğin altına girince alçalma hızını azaltmaya başlar. Tipik değer 10 m. "Son yaklaşma yüksekliği"nden büyük olmalıdır.', 'Below this height the landing vehicle starts reducing its descent speed. Typically 10 m. It must be larger than the "Final approach height".'),
          map: [px4mc(p('MPC_LAND_ALT1'))],
        },
        {
          id: 'landAltLow', kind: 'number', unit: 'm', min: 1, max: 100, step: 1, gauge: 'altitude',
          title: L('Son yaklaşma yüksekliği', 'Final approach height'),
          desc: L('Araç bu yüksekliğin altına inince "Yere değme hızı"na geçer. Tipik değer 10 m. Yükseklik ölçümü hatalı olabilecekse (eğimli arazi, barometre kayması) bu değeri büyük tutmak yere hızlı çarpmayı önler.', 'Below this height the vehicle switches to the "Touchdown speed". Typically 10 m. If the height reading may be off (sloping terrain, barometer drift) keep it large to avoid hitting the ground fast.'),
          map: [
            cop(pi('LAND_ALT_LOW', 100)),
            px4mc(p('MPC_LAND_ALT2'), { min: 0, max: 122, linked: (v, get) => {
              const a1 = get('MPC_LAND_ALT1');
              return a1 !== undefined && a1 < v ? [{ name: 'MPC_LAND_ALT1', value: v, why: L('Yavaşlamaya başlama yüksekliği son yaklaşma yüksekliğinden küçük olamaz; o da yükseltilir.', 'The slow-down start height cannot be below the final approach height, so it is raised as well.') }] : [];
            } }),
          ],
        },
        {
          id: 'landReposition', kind: 'toggle', gauge: null,
          title: L('İnerken konumu düzeltme', 'Repositioning while landing'),
          desc: L('Açıkken otomatik iniş sırasında kumanda çubuklarıyla aracı yana kaydırıp iniş yerini düzeltebilirsiniz. Kapatırsanız araç bulunduğu noktaya dümdüz iner. İniş yerinde engel çıkma ihtimaline karşı açık tutmanız önerilir.', 'When on, you can nudge the vehicle sideways with the sticks during an automatic landing to adjust the spot. When off it lands straight down where it is. Keeping it on is recommended in case an obstacle appears at the landing spot.'),
          map: [cop(p('LAND_REPOSITION', 1, { on: 1, off: 0 })), px4mc(p('MPC_LAND_RC_HELP', 1, { on: 1, off: 0 }))],
        },
        {
          id: 'disarmDelay', kind: 'number', unit: 's', min: 0, max: 127, step: 1, gauge: 'time',
          zero: L('0: motorlar kendiliğinden durmaz', '0: the motors never stop by themselves'),
          title: L('Yerde motorları durdurma süresi', 'Auto-disarm delay on the ground'),
          desc: L('Araç yerdeyken ve gaz en alttayken motorların kendiliğinden kapanması (disarm) için beklenen süredir. Tipik değer 10 s. Kısa süre, indikten sonra dönen pervanelerin tehlikesini azaltır; 0 yaparsanız motorları her zaman kendiniz kapatmanız gerekir.', 'How long the vehicle waits on the ground with the throttle at minimum before disarming the motors by itself. Typically 10 s. A short delay reduces the danger of spinning props after landing; at 0 you must always disarm yourself.'),
          map: [
            cop(pi('DISARM_DELAY')),
            px4(p('COM_DISARM_LAND'), { min: -1, max: 20, step: 0.5, zero: null, desc: L('Araç indiğini algıladıktan sonra motorların kendiliğinden kapanması için beklenen süredir. Tipik değer 2 s. Negatif değer (−1) kendiliğinden kapanmayı devre dışı bırakır; o zaman motorları her zaman kendiniz kapatmanız gerekir.', 'How long after a detected landing the motors are disarmed automatically. Typically 2 s. A negative value (−1) disables automatic disarming; you must then always disarm yourself.') }),
          ],
        },
      ],
    },

    // ============================== EVE DÖNÜŞ ==============================
    {
      id: 'rtl', icon: 'home', title: L('Eve dönüş', 'Return to home'),
      intro: L('"Eve dön" (RTL) komutunda ya da bir arıza durumunda aracın kalkış noktasına nasıl döneceğini belirler: önce hangi yüksekliğe çıkacağı, hangi hızla döneceği ve evin üstünde ne yapacağı. Dönüş yüksekliğini bölgedeki en yüksek engelin üstünde tutun.', 'Controls how the vehicle comes back to the launch point on a "Return" (RTL) command or after a failure: the height it climbs to first, the speed it returns at and what it does above home. Keep the return altitude above the tallest obstacle in the area.'),
      settings: [
        {
          id: 'rtlAlt', kind: 'number', unit: 'm', min: 0, max: 300, step: 1, gauge: 'altitude',
          zero: L('0: bulunduğu yükseklikte döner', '0: returns at its current altitude'),
          title: L('Dönüş yüksekliği', 'Return altitude'),
          desc: L('Araç eve dönmeden önce en az bu yüksekliğe çıkar; zaten daha yüksekteyse bulunduğu yükseklikte döner. Tipik değer 15–30 m. Mutlaka çevredeki ağaç, direk ve binalardan yüksek seçin; çok yüksek değer ise dönüşte gereksiz batarya harcar.', 'The vehicle climbs to at least this height before heading home; if already higher it returns at its current altitude. Typically 15–30 m. Always choose it above nearby trees, poles and buildings; an excessive value wastes battery on the way back.'),
          map: [
            cop(pi('RTL_ALT', 100)),
            px4(p('RTL_RETURN_ALT'), { max: 150, zero: null }),
            plane(p('RTL_ALTITUDE'), { min: -1, max: 300, zero: null, desc: L('Uçak eve bu yükseklikte döner ve evin üstünde bu yükseklikte tur atar. Tipik değer 100 m. −1 verirseniz bulunduğu yükseklikte döner. Arazinin ve engellerin üstünde güvenli bir pay bırakın.', 'The plane returns at this altitude and circles above home at it. Typically 100 m. With −1 it returns at its current altitude. Leave a safe margin above terrain and obstacles.') }),
            plane(pi('ALT_HOLD_RTL', 100), { min: -1, max: 300, zero: null, desc: L('Uçak eve bu yükseklikte döner ve evin üstünde bu yükseklikte tur atar. Tipik değer 100 m. Arazinin ve engellerin üstünde güvenli bir pay bırakın.', 'The plane returns at this altitude and circles above home at it. Typically 100 m. Leave a safe margin above terrain and obstacles.') }),
          ],
        },
        {
          id: 'rtlSpeed', kind: 'number', unit: 'm/s', min: 0, max: 20, step: 0.5, gauge: 'speed',
          zero: L('0: görev hızı kullanılır', '0: the mission speed is used'),
          title: L('Dönüş hızı', 'Return speed'),
          desc: L('Aracın eve dönerken kullanacağı yatay hızdır. 0 bırakırsanız "Görev hızı" kullanılır. Batarya azken eve yetişebilmek için aracın en verimli hızına yakın bir değer (çoğu araçta 8–12 m/s) seçmek iyi olur.', 'The horizontal speed used while returning home. At 0 the "Mission speed" is used. Choosing a value near the vehicle\'s most efficient speed (8–12 m/s on most) helps it make it home on a low battery.'),
          map: [cop(pi('RTL_SPEED', 100)), rover(p('RTL_SPEED'), { step: 0.1, zero: L('0: görev / seyir hızı kullanılır', '0: the mission / cruise speed is used') })],
        },
        {
          id: 'rtlClimbMin', kind: 'number', unit: 'm', min: 0, max: 30, step: 0.5, gauge: 'altitude',
          zero: L('0: ek tırmanma yok', '0: no extra climb'),
          title: L('Dönüşte en az tırmanma', 'Minimum climb on return'),
          desc: L('Eve dönüş başladığında araç, bulunduğu yükseklik ne olursa olsun en az bu kadar yükselir. Araç evin hemen yakınında alçakta uçarken dönüş başlarsa çevredeki engellere takılmamasını sağlar. 2–5 m çoğu durumda yeterlidir.', 'When a return starts the vehicle climbs at least this much, whatever its current height. It keeps the vehicle clear of nearby obstacles if the return starts low and close to home. 2–5 m is enough in most cases.'),
          map: [cop(pi('RTL_CLIMB_MIN', 100))],
        },
        {
          id: 'rtlCone', kind: 'number', unit: '', min: 0, max: 10, step: 0.1, gauge: 'bar',
          ends: [L('Yayvan', 'Shallow'), L('Dik', 'Steep')],
          zero: L('0: koni kapalı; her zaman tam dönüş yüksekliğine çıkar', '0: cone off; always climbs to the full return altitude'),
          title: L('Eve yakınken tırmanma konisi', 'Climb cone near home'),
          desc: L('Araç eve yakınsa tam dönüş yüksekliğine çıkmasına gerek yoktur: evin üstünde ters bir koni düşünün; araç yalnızca bu koninin yüzeyine kadar yükselir. Değer koninin dikliğidir (tipik 3). Küçük değer yakın mesafede daha az tırmanma, 0 ise her zaman tam yüksekliğe çıkma demektir.', 'Close to home there is no need to climb to the full return altitude: imagine an inverted cone above home; the vehicle only climbs up to its surface. The value is the steepness of the cone (typically 3). Smaller means less climbing when near, 0 means always climbing to the full altitude.'),
          map: [cop(p('RTL_CONE_SLOPE'))],
        },
        {
          id: 'rtlLoiterTime', kind: 'number', unit: 's', min: 0, max: 60, step: 1, gauge: 'time',
          title: L('Evin üstünde bekleme süresi', 'Wait above home'),
          desc: L('Araç evin üstüne vardıktan sonra inişe geçmeden önce bu kadar bekler. Tipik değer 5 s. Bu süre, iniş alanını boşaltmanız ya da kontrolü elinize almanız için zaman kazandırır.', 'After arriving above home the vehicle waits this long before starting to descend. Typically 5 s. It gives you time to clear the landing area or take over control.'),
          map: [
            cop(pi('RTL_LOIT_TIME', 1000)),
            px4(p('RTL_LAND_DELAY'), { min: -1, max: 300, desc: L('Araç evin üstünde alçaldıktan sonra inişe geçmeden önce bu kadar bekler. −1 verirseniz inmez, siz komut verene kadar havada bekler. Bu süre iniş alanını boşaltmanız için zaman kazandırır.', 'After descending above home the vehicle waits this long before landing. With −1 it does not land and hovers until you command it. The wait gives you time to clear the landing area.') }),
          ],
        },
        {
          id: 'rtlAltFinal', kind: 'number', unit: 'm', min: 0, max: 10, step: 0.5, gauge: 'altitude',
          zero: L('0: araç yere iner', '0: the vehicle lands'),
          title: L('Dönüş sonunda bekleme yüksekliği', 'Final hover altitude'),
          desc: L('Eve dönüşün sonunda aracın inip inmeyeceğini belirler. 0 ise araç yere iner ve motorlarını kapatır. 0\'dan büyük bir değer verirseniz araç bu yüksekliğe alçalıp havada bekler; inişi kendiniz yaparsınız.', 'Decides whether the vehicle lands at the end of a return. At 0 it lands and disarms. With a value above 0 it descends to this height and hovers; you do the landing yourself.'),
          map: [
            cop(pi('RTL_ALT_FINAL', 100)),
            px4(p('RTL_DESCEND_ALT'), { min: 2, max: 100, step: 1, zero: null, desc: L('Araç evin üstüne varınca önce bu yüksekliğe alçalır ve "bekleme süresi" kadar bekler, sonra iner. Tipik değer 30 m. İniş alanını görebileceğiniz ama engellerin üstünde kalan bir yükseklik seçin.', 'Above home the vehicle first descends to this height, waits for the "wait" time, then lands. Typically 30 m. Choose a height from which you can see the landing area but that still clears obstacles.') }),
          ],
        },
        {
          id: 'rtlAltType', kind: 'select', gauge: null,
          title: L('Dönüş yüksekliğinin ölçüsü', 'Return altitude reference'),
          desc: L('Dönüş yüksekliğinin neye göre ölçüleceğini seçer. "Kalkış noktasına göre" düz arazide yeterlidir. Engebeli arazide "araziye göre" seçerseniz araç yer şeklini izleyerek döner; bunun için mesafe ölçer ya da arazi verisi gerekir.', 'Chooses what the return altitude is measured against. "Relative to home" is fine on flat ground. In hilly terrain "above terrain" makes the vehicle follow the ground on the way back; this needs a rangefinder or terrain data.'),
          options: [o(0, 'Kalkış noktasına göre', 'Relative to home'), o(1, 'Araziye göre', 'Above terrain', 'Mesafe ölçer ya da arazi verisi gerekir', 'Needs a rangefinder or terrain data')],
          map: [cop(pi('RTL_ALT_TYPE'))],
        },
        {
          id: 'rtlMinDist', kind: 'number', unit: 'm', min: 0.5, max: 100, step: 0.5, gauge: 'bar',
          ends: [L('Ev', 'Home'), L('Uzak', 'Far')],
          title: L('Yakındayken tırmanmama mesafesi', 'No-climb distance near home'),
          desc: L('Araç eve bu mesafeden daha yakınken dönüş başlarsa dönüş yüksekliğine tırmanmaz, doğrudan evin üstüne gelip iner. Tipik değer 10 m. Çevrede engel varsa küçük tutun.', 'If a return starts closer to home than this, the vehicle does not climb to the return altitude and goes straight above home to land. Typically 10 m. Keep it small if there are obstacles around.'),
          map: [px4(p('RTL_MIN_DIST'))],
        },
      ],
    },

    // ============================== GÜVENLİK ==============================
    {
      id: 'failsafe', icon: 'alert', title: L('Güvenlik ve arıza davranışı', 'Safety and failsafe'),
      intro: L('Bir şeyler ters gittiğinde aracın kendi başına ne yapacağını belirler: kumanda sinyali kesilirse, yer istasyonu bağlantısı koparsa, batarya azalırsa ya da konum kestirimi bozulursa. Bu korumaları kapatmak aracı kaybetmenize yol açabilir; değiştirmeden önce açıklamaları okuyun.', 'Decides what the vehicle does on its own when things go wrong: if the radio signal is lost, the ground-station link drops, the battery runs low or the position estimate degrades. Turning these protections off can cost you the vehicle; read the notes before changing them.'),
      settings: [
        {
          id: 'rcLoss', kind: 'select', gauge: null,
          title: L('Kumanda sinyali kesilirse', 'If the radio signal is lost'),
          desc: L('Kumandayla bağlantı koptuğunda aracın ne yapacağını seçer. Çoğu durumda en güvenlisi "Eve dön"dür; ev ile araç arasında engel varsa "İn" daha uygun olabilir. Kapalıyken araç son komutla uçmaya devam eder ve uzaklaşabilir.', 'Chooses what the vehicle does when the link to the radio is lost. "Return home" is safest in most cases; "Land" may be better if obstacles lie between the vehicle and home. When disabled the vehicle keeps flying on the last command and may fly away.'),
          risk: (v) => (v === 0 ? L('Kumanda kaybı koruması kapatılıyor: sinyal kesilirse araç son komutla uçmayı sürdürür ve kaybolabilir.', 'Radio-loss protection is being turned off: if the signal drops the vehicle keeps flying on the last command and may be lost.') : null),
          options: [
            o(0, 'Kapalı', 'Disabled', 'Koruma yok', 'No protection'),
            o(1, 'Eve dön (RTL)', 'Return home (RTL)'),
            o(3, 'İn', 'Land', 'Bulunduğu yere iner', 'Lands where it is'),
            o(4, 'Akıllı eve dönüş, olmazsa RTL', 'SmartRTL, else RTL', 'Geldiği yoldan geri döner', 'Returns along the path it came'),
            o(5, 'Akıllı eve dönüş, olmazsa in', 'SmartRTL, else Land'),
            o(6, 'Görevdeki iniş rotasına git, yoksa RTL', 'Mission landing sequence, else RTL'),
            o(7, 'Frenle, olmazsa in', 'Brake, else Land'),
          ],
          map: [
            cop(pi('FS_THR_ENABLE')),
            px4(pi('NAV_RCL_ACT'), {
              risk: (v) => (v === 5 || v === 6 ? L('Bu seçenek havadaki aracın motorlarını durdurur; araç düşer.', 'This option stops the motors of an airborne vehicle; it will fall.') : null),
              options: [
                o(1, 'Havada bekle', 'Hold', 'Bulunduğu yerde bekler', 'Hovers / circles in place'),
                o(2, 'Eve dön', 'Return'),
                o(3, 'İn', 'Land'),
                o(5, 'Uçuşu sonlandır', 'Terminate', 'Tehlikeli: araç düşer', 'Dangerous: the vehicle falls'),
                o(6, 'Motorları kapat', 'Disarm', 'Tehlikeli: araç düşer', 'Dangerous: the vehicle falls'),
              ],
            }),
          ],
        },
        {
          id: 'rcLossPwm', kind: 'number', unit: 'PWM', min: 910, max: 1100, step: 1, gauge: 'bar',
          ends: [L('910', '910'), L('1100', '1100')],
          title: L('Sinyal kaybı gaz eşiği', 'Radio-loss throttle threshold'),
          desc: L('Gaz kanalının değeri bu eşiğin altına düşerse kumanda sinyali kesilmiş sayılır. Alıcınızın sinyal kaybında verdiği değerden en az 10 yüksek, çubuk en alttayken verdiği değerden en az 10 düşük olmalıdır. Tipik değer 975. Yanlış ayarlanırsa koruma ya hiç çalışmaz ya da normal uçuşta devreye girer.', 'If the throttle channel drops below this value the radio signal is considered lost. It must be at least 10 above what your receiver outputs on signal loss and at least 10 below the stick-down value. Typically 975. Set wrongly, the protection either never triggers or triggers in normal flight.'),
          map: [cop(pi('FS_THR_VALUE'))],
        },
        {
          id: 'rcLossDelay', kind: 'number', unit: 's', min: 0.5, max: 10, step: 0.1, gauge: 'time',
          title: L('Sinyal kaybında bekleme süresi', 'Radio-loss delay'),
          desc: L('Kumanda sinyali bu süre boyunca hiç gelmezse arıza davranışı başlatılır. Tipik değer 1 s. Kısa süre hızlı tepki verir; çok kısa tutarsanız anlık sinyal kesintileri gereksiz yere eve dönüş başlatır.', 'The failsafe starts when no radio signal arrives for this long. Typically 1 s. A short delay reacts quickly; too short and brief dropouts trigger needless returns.'),
          map: [cop(p('RC_FS_TIMEOUT')), px4(p('COM_RC_LOSS_T'), { min: 0, max: 35 })],
        },
        {
          id: 'gcsLoss', kind: 'select', gauge: null,
          title: L('Yer istasyonu bağlantısı koparsa', 'If the ground-station link is lost'),
          desc: L('Bu yazılımla (yer istasyonu) telemetri bağlantısı koptuğunda aracın ne yapacağını seçer. Aracı yalnızca bilgisayardan yönetiyorsanız mutlaka "Eve dön" ya da "İn" seçin. Kumandayla uçuyor ve telemetriyi yalnızca izleme için kullanıyorsanız kapalı kalabilir.', 'Chooses what the vehicle does when the telemetry link to this software (the ground station) drops. If you fly from the computer only, be sure to select "Return home" or "Land". If you fly with a radio and use telemetry for monitoring only, it can stay disabled.'),
          risk: (v) => (v === 0 ? L('Yer istasyonu kaybı koruması kapatılıyor: bağlantı koparsa araç hiçbir şey yapmaz. Kumanda kullanmıyorsanız aracı geri çağıramazsınız.', 'Ground-station-loss protection is being turned off: the vehicle does nothing if the link drops. Without a radio you cannot call it back.') : null),
          options: [
            o(0, 'Kapalı', 'Disabled', 'Koruma yok', 'No protection'),
            o(1, 'Eve dön (RTL)', 'Return home (RTL)'),
            o(3, 'Akıllı eve dönüş, olmazsa RTL', 'SmartRTL, else RTL'),
            o(4, 'Akıllı eve dönüş, olmazsa in', 'SmartRTL, else Land'),
            o(5, 'İn', 'Land'),
            o(6, 'Görevdeki iniş rotasına git, yoksa RTL', 'Mission landing sequence, else RTL'),
            o(7, 'Frenle, olmazsa in', 'Brake, else Land'),
          ],
          map: [
            cop(pi('FS_GCS_ENABLE')),
            px4(pi('NAV_DLL_ACT'), {
              risk: (v) => (v === 0 ? L('Yer istasyonu kaybı koruması kapatılıyor: bağlantı koparsa araç hiçbir şey yapmaz.', 'Ground-station-loss protection is being turned off: the vehicle does nothing if the link drops.') : v === 5 || v === 6 ? L('Bu seçenek havadaki aracın motorlarını durdurur; araç düşer.', 'This option stops the motors of an airborne vehicle; it will fall.') : null),
              options: [
                o(0, 'Kapalı', 'Disabled', 'Koruma yok', 'No protection'),
                o(1, 'Havada bekle', 'Hold'),
                o(2, 'Eve dön', 'Return'),
                o(3, 'İn', 'Land'),
                o(5, 'Uçuşu sonlandır', 'Terminate', 'Tehlikeli: araç düşer', 'Dangerous: the vehicle falls'),
                o(6, 'Motorları kapat', 'Disarm', 'Tehlikeli: araç düşer', 'Dangerous: the vehicle falls'),
              ],
            }),
          ],
        },
        {
          id: 'gcsLossDelay', kind: 'number', unit: 's', min: 2, max: 120, step: 1, gauge: 'time',
          title: L('Yer istasyonu kaybında bekleme süresi', 'Ground-station-loss delay'),
          desc: L('Yer istasyonundan bu süre boyunca hiç veri gelmezse bağlantı kopmuş sayılır. Tipik değer 5 s. Bağlantınız sık sık kısa süreli kesiliyorsa (uzak mesafe, zayıf telemetri) süreyi uzatın.', 'The link is considered lost when nothing arrives from the ground station for this long. Typically 5 s. Lengthen it if your link often drops briefly (long range, weak telemetry).'),
          map: [cop(p('FS_GCS_TIMEOUT')), px4(pi('COM_DL_LOSS_T'), { min: 5, max: 300 })],
        },
        {
          id: 'fsOptions', kind: 'bits', gauge: null,
          title: L('Arıza durumunda istisnalar', 'Failsafe exceptions'),
          desc: L('Sinyal ya da bağlantı kaybında aracın yaptığı işi bırakmaması gereken durumları seçer. Örneğin menzil dışına çıkan uzun bir otomatik görevde kumanda kaybı normaldir; "görevde devam et" işaretliyse araç görevi tamamlar. İşaretlediğiniz her kutu o durumda korumayı devre dışı bırakır.', 'Selects the situations in which the vehicle should carry on despite a signal or link loss. On a long automatic mission beyond radio range, for example, losing the radio is expected; with "continue the mission" ticked the vehicle completes it. Every ticked box disables the protection for that case.'),
          bits: [
            { bit: 0, label: L('Otomatik görevdeyken kumanda kaybında devam et', 'Continue the mission on radio loss in Auto') },
            { bit: 1, label: L('Otomatik görevdeyken yer istasyonu kaybında devam et', 'Continue the mission on ground-station loss in Auto') },
            { bit: 2, label: L('Guided kipindeyken kumanda kaybında devam et', 'Continue in Guided on radio loss') },
            { bit: 3, label: L('İniş sırasında her arızada inişe devam et', 'Continue landing on any failsafe') },
            { bit: 4, label: L('Pilot kontrolündeki kiplerde yer istasyonu kaybını yok say', 'Ignore ground-station loss in pilot-controlled modes') },
            { bit: 5, label: L('Arızada tutucuyu (gripper) bırak', 'Release the gripper on failsafe') },
          ],
          map: [cop(pi('FS_OPTIONS'))],
        },
        {
          id: 'battLowVolt', kind: 'number', unit: 'V', min: 0, max: 60, step: 0.1, gauge: 'battery',
          zero: L('0: gerilime göre uyarı kapalı', '0: voltage-based warning off'),
          title: L('Düşük batarya gerilimi', 'Low battery voltage'),
          desc: L('Batarya gerilimi bu değerin altına düşüp bir süre orada kalırsa "düşük batarya" davranışı başlar. LiPo için hücre başına 3,5–3,6 V iyi bir başlangıçtır (4 hücreli bataryada 14,0–14,4 V). Çok düşük seçerseniz eve dönmeye yetecek enerji kalmayabilir.', 'When the battery voltage stays below this value for a while the "low battery" action starts. 3.5–3.6 V per cell is a good start for LiPo (14.0–14.4 V on a 4-cell pack). Set too low, there may not be enough energy left to get home.'),
          map: [ap(p('BATT_LOW_VOLT'), { linked: (v, get) => {
            const crit = get('BATT_CRT_VOLT');
            return v > 0 && crit !== undefined && crit > 0 && crit >= v ? [{ name: 'BATT_CRT_VOLT', value: r6(Math.max(0, v - 0.5)), why: L('Kritik gerilim düşük gerilimden küçük olmalıdır; bu yüzden kritik eşik de 0,5 V aşağıya çekilir.', 'The critical voltage must be below the low voltage, so the critical threshold is moved 0.5 V below it.') }] : [];
          } })],
        },
        {
          id: 'battLowAct', kind: 'select', gauge: null,
          title: L('Batarya azalınca', 'When the battery is low'),
          desc: L('Batarya "düşük" eşiğinin altına indiğinde aracın ne yapacağını seçer. Önerilen: "Eve dön". "Hiçbir şey yapma" seçerseniz yalnızca uyarı alırsınız ve eve dönüş kararını zamanında sizin vermeniz gerekir.', 'Chooses what the vehicle does when the battery falls below the "low" threshold. Recommended: "Return home". With "Do nothing" you only get a warning and must decide to come back in time yourself.'),
          risk: lowActRisk,
          options: COPTER_BATT_ACT,
          map: [
            cop(pi('BATT_FS_LOW_ACT')),
            px4(pi('COM_LOW_BAT_ACT'), {
              risk: (v) => (v === 0 ? L('Batarya koruması yalnızca uyarıya indiriliyor: batarya bitse bile araç kendiliğinden inmez ya da dönmez.', 'Battery protection is reduced to a warning: the vehicle will not land or return by itself even when the battery runs out.') : null),
              options: [
                o(0, 'Yalnızca uyar', 'Warning only', 'Araç kendiliğinden bir şey yapmaz', 'The vehicle does nothing by itself'),
                o(2, 'İn', 'Land', 'Kritik seviyede bulunduğu yere iner', 'Lands in place at the critical level'),
                o(3, 'Kritikte eve dön, acil seviyede in', 'Return at critical, land at emergency'),
              ],
            }),
          ],
        },
        {
          id: 'battCritVolt', kind: 'number', unit: 'V', min: 0, max: 60, step: 0.1, gauge: 'battery',
          zero: L('0: gerilime göre kritik koruma kapalı', '0: voltage-based critical protection off'),
          title: L('Kritik batarya gerilimi', 'Critical battery voltage'),
          desc: L('Gerilim bu değerin altına düşerse "kritik batarya" davranışı başlar; bu, aracı kurtarmak için son basamaktır. LiPo için hücre başına 3,3 V civarı uygundur (4 hücrede 13,2 V). Düşük batarya eşiğinden küçük olmalıdır.', 'Below this voltage the "critical battery" action starts; this is the last line of defence for the vehicle. About 3.3 V per cell suits LiPo (13.2 V on 4 cells). It must be below the low-battery threshold.'),
          map: [ap(p('BATT_CRT_VOLT'), { linked: (v, get) => {
            const low = get('BATT_LOW_VOLT');
            return v > 0 && low !== undefined && low > 0 && low <= v ? [{ name: 'BATT_LOW_VOLT', value: r6(v + 0.5), why: L('Düşük gerilim eşiği kritik eşikten büyük olmalıdır; bu yüzden düşük eşik de 0,5 V yukarıya çekilir.', 'The low-voltage threshold must be above the critical one, so it is moved 0.5 V above it.') }] : [];
          } })],
        },
        {
          id: 'battCritAct', kind: 'select', gauge: null,
          title: L('Batarya kritik seviyeye inince', 'When the battery is critical'),
          desc: L('Batarya "kritik" eşiğin altına indiğinde aracın ne yapacağını seçer. Önerilen: "İn"; çünkü bu noktada eve dönmeye yetecek enerji kalmamış olabilir ve bataryanın havada tükenmesi aracın düşmesi demektir.', 'Chooses what the vehicle does below the "critical" threshold. Recommended: "Land", because at this point there may not be enough energy to get home and a battery dying in the air means a crash.'),
          risk: lowActRisk,
          options: COPTER_BATT_ACT,
          map: [cop(pi('BATT_FS_CRT_ACT'))],
        },
        {
          id: 'battLowTimer', kind: 'number', unit: 's', min: 0, max: 120, step: 1, gauge: 'time',
          title: L('Düşük gerilim onay süresi', 'Low-voltage confirmation time'),
          desc: L('Gerilim eşiğin altında bu süre boyunca kesintisiz kalırsa düşük batarya sayılır. Tipik değer 10 s. Sert gaz vermelerde gerilim anlık düşer; bu süre o anlık düşüşlerin yanlış alarm vermesini önler.', 'The battery counts as low only if the voltage stays below the threshold continuously for this long. Typically 10 s. Voltage sags briefly under hard throttle; this delay keeps those sags from raising false alarms.'),
          map: [ap(pi('BATT_LOW_TIMER'))],
        },
        {
          id: 'battCapacity', kind: 'number', unit: 'mAh', min: 0, max: 50000, step: 50, gauge: 'bar',
          ends: [L('0', '0'), L('50 Ah', '50 Ah')],
          title: L('Batarya kapasitesi', 'Battery capacity'),
          desc: L('Taktığınız bataryanın etiketindeki kapasitedir. Kalan yüzde ve "kalan kapasite" eşikleri bu değere göre hesaplanır; yanlış girilirse yüzde göstergesi yanıltır. Batarya değiştirdiğinizde burayı da güncelleyin.', 'The capacity printed on the battery you fitted. The remaining percentage and the "remaining capacity" thresholds are computed from it; a wrong value makes the percentage misleading. Update it whenever you change batteries.'),
          map: [ap(pi('BATT_CAPACITY')), px4(p('BAT1_CAPACITY'), { min: -1, max: 100000 })],
        },
        {
          id: 'battLowMah', kind: 'number', unit: 'mAh', min: 0, max: 50000, step: 50, gauge: 'battery',
          zero: L('0: kalan kapasiteye göre uyarı kapalı', '0: capacity-based warning off'),
          title: L('Düşük sayılacak kalan kapasite', 'Low remaining capacity'),
          desc: L('Bataryada kalan kapasite bu değerin altına inince "düşük batarya" davranışı başlar. Kapasitenin %20–25\'i iyi bir değerdir (5000 mAh batarya için 1000–1250 mAh). Akım sensörü olmayan araçlarda çalışmaz; 0 bu denetimi kapatır.', 'The "low battery" action starts when the remaining capacity falls below this value. 20–25 % of the capacity is a good choice (1000–1250 mAh for a 5000 mAh pack). It does not work without a current sensor; 0 turns this check off.'),
          map: [ap(p('BATT_LOW_MAH'))],
        },
        {
          id: 'battCritMah', kind: 'number', unit: 'mAh', min: 0, max: 50000, step: 50, gauge: 'battery',
          zero: L('0: kalan kapasiteye göre kritik koruma kapalı', '0: capacity-based critical protection off'),
          title: L('Kritik sayılacak kalan kapasite', 'Critical remaining capacity'),
          desc: L('Kalan kapasite bu değerin altına inince "kritik batarya" davranışı başlar. Kapasitenin %10\'u civarı uygundur. Düşük kapasite eşiğinden küçük olmalıdır; 0 bu denetimi kapatır.', 'The "critical battery" action starts when the remaining capacity falls below this value. About 10 % of the capacity is suitable. It must be below the low-capacity threshold; 0 turns this check off.'),
          map: [ap(p('BATT_CRT_MAH'))],
        },
        {
          id: 'battLowPct', kind: 'number', unit: '%', min: 12, max: 50, step: 1, gauge: 'battery',
          title: L('Düşük batarya seviyesi', 'Low battery level'),
          desc: L('Kalan batarya bu yüzdenin altına inince düşük batarya uyarısı verilir. Tipik değer %15. Uzak mesafe uçuyorsanız eve dönüş payı bırakmak için yükseltin.', 'A low-battery warning is raised when the remaining charge falls below this percentage. Typically 15 %. Raise it for long-range flights to leave a margin for the way home.'),
          map: [px4(p('BAT_LOW_THR', 0.01))],
        },
        {
          id: 'battCritPct', kind: 'number', unit: '%', min: 5, max: 50, step: 1, gauge: 'battery',
          title: L('Kritik batarya seviyesi', 'Critical battery level'),
          desc: L('Kalan batarya bu yüzdenin altına inince seçtiğiniz batarya davranışı (eve dönüş ya da iniş) başlar. Tipik değer %7. Düşük seviye eşiğinden küçük olmalıdır.', 'Below this percentage the selected battery action (return or land) starts. Typically 7 %. It must be below the low-level threshold.'),
          map: [px4(p('BAT_CRIT_THR', 0.01))],
        },
        {
          id: 'battEmergPct', kind: 'number', unit: '%', min: 3, max: 50, step: 1, gauge: 'battery',
          title: L('Acil batarya seviyesi', 'Emergency battery level'),
          desc: L('Kalan batarya bu yüzdenin altına inince araç bulunduğu yere hemen iner. Tipik değer %5. Kritik seviye eşiğinden küçük olmalıdır.', 'Below this percentage the vehicle lands immediately where it is. Typically 5 %. It must be below the critical-level threshold.'),
          map: [px4(p('BAT_EMERGEN_THR', 0.01))],
        },
        {
          id: 'ekfAction', kind: 'select', gauge: null,
          title: L('Konum kestirimi bozulursa', 'If the position estimate fails'),
          desc: L('GPS ya da pusula verisi güvenilmez hale gelip aracın konum kestirimi (EKF) bozulursa ne yapılacağını seçer. Bu durumda araç nerede olduğunu bilmediği için eve dönemez. "İn" genelde en güvenlisidir; "İrtifa tut" seçerseniz kontrol size geçer ve aracı elle indirmeniz gerekir.', 'Chooses what happens when GPS or compass data becomes unreliable and the position estimate (EKF) fails. The vehicle cannot return home then because it does not know where it is. "Land" is usually safest; with "Altitude hold" control passes to you and you must bring it down manually.'),
          options: [
            o(1, 'İn', 'Land'),
            o(2, 'İrtifa tut (kontrol pilota geçer)', 'Altitude hold (pilot takes over)'),
            o(3, 'Stabilize kipinde bile in', 'Land even in Stabilize'),
          ],
          map: [cop(pi('FS_EKF_ACTION'))],
        },
        {
          id: 'crashCheck', kind: 'toggle', gauge: null,
          title: L('Kaza algılama', 'Crash detection'),
          desc: L('Açıkken araç devrildiğini ya da yere çarptığını algılayınca motorları kendiliğinden durdurur; böylece pervaneler, motorlar ve çevredekiler korunur. Kapatmanız önerilmez.', 'When on, the vehicle stops its motors by itself once it detects it has flipped or hit the ground, protecting props, motors and bystanders. Turning it off is not recommended.'),
          risk: (v) => (v === false ? L('Kaza algılama kapatılıyor: araç devrilse bile motorlar dönmeye devam eder.', 'Crash detection is being turned off: the motors keep spinning even if the vehicle flips over.') : null),
          map: [cop(p('FS_CRASH_CHECK', 1, { on: 1, off: 0 }))],
        },
        {
          id: 'vibeFs', kind: 'toggle', gauge: null,
          title: L('Titreşim koruması', 'Vibration failsafe'),
          desc: L('Aşırı titreşim irtifa kestirimini bozup aracın kontrolsüz yükselmesine yol açabilir. Açıkken araç böyle bir durumu algılayınca titreşime daha dayanıklı bir irtifa denetimine geçer. Açık bırakmanız önerilir.', 'Excessive vibration can corrupt the altitude estimate and make the vehicle climb uncontrollably. When on, the vehicle switches to a more vibration-tolerant altitude controller once it detects this. Leaving it on is recommended.'),
          map: [cop(p('FS_VIBE_ENABLE', 1, { on: 1, off: 0 }))],
        },
        {
          id: 'armingCheck', kind: 'toggle', gauge: null,
          title: L('Kalkış öncesi güvenlik denetimleri', 'Pre-arm safety checks'),
          desc: L('Motorlar kurulmadan önce sensörlerin, GPS\'in, bataryanın ve kumandanın sağlıklı olup olmadığını denetler; sorun varsa motorları kurdurmaz. Kapatırsanız araç arızalı sensörle bile kalkabilir. Yalnızca masa başı denemelerinde ve pervaneler sökülüyken kapatın.', 'Checks that the sensors, GPS, battery and radio are healthy before the motors can be armed, and refuses to arm otherwise. With it off the vehicle can take off even with a faulty sensor. Only turn it off for bench tests with the propellers removed.'),
          risk: (v) => (v === false ? L('Kalkış öncesi denetimlerin TAMAMI kapatılıyor: araç bozuk sensör, kalibre edilmemiş pusula ya da GPS\'siz kurulabilir. Bu, kazaların en sık nedenlerinden biridir.', 'ALL pre-arm checks are being turned off: the vehicle can arm with a broken sensor, an uncalibrated compass or no GPS. This is one of the most common causes of crashes.') : null),
          map: [ap(p('ARMING_CHECK', 1, { on: 1, off: 0 }))],
        },
      ],
    },

    // ============================== COĞRAFİ ÇİT ==============================
    {
      id: 'fence', icon: 'polygon', title: L('Coğrafi çit', 'Geofence'),
      intro: L('Aracın çıkamayacağı görünmez bir sınır tanımlar: evin çevresinde bir daire ve bir yükseklik tavanı. Araç sınıra ulaşınca seçtiğiniz eylemi (örneğin eve dönüş) kendiliğinden yapar. Yeni pilotlar ve kalabalık alanlar için önerilir.', 'Defines an invisible boundary the vehicle may not leave: a circle around home and an altitude ceiling. On reaching it the vehicle performs the action you chose (for example return home) by itself. Recommended for new pilots and busy areas.'),
      settings: [
        {
          id: 'fenceEnable', kind: 'toggle', gauge: null,
          title: L('Çit', 'Fence'),
          desc: L('Coğrafi çiti açar ya da kapatır. Açıkken araç aşağıdaki sınırların dışına çıkamaz; ayrıca çit açıkken GPS konumu alınmadan motorlar kurulmaz. Kapalıyken hiçbir sınır uygulanmaz.', 'Turns the geofence on or off. When on, the vehicle cannot leave the limits below, and the motors will not arm without a GPS position. When off no limit is enforced.'),
          risk: (v) => (v === false ? L('Coğrafi çit kapatılıyor: araç yükseklik ve uzaklık sınırı olmadan uçabilir.', 'The geofence is being turned off: the vehicle can fly with no altitude or distance limit.') : null),
          map: [ap(p('FENCE_ENABLE', 1, { on: 1, off: 0 }))],
        },
        {
          id: 'fenceType', kind: 'bits', gauge: null,
          title: L('Çit türleri', 'Fence types'),
          desc: L('Hangi sınırların uygulanacağını seçer. "Yükseklik tavanı" ve "daire" en yaygın ikilidir. "Çokgen bölgeler" görev planlayıcıda çizdiğiniz izinli ve yasak alanları kullanır.', 'Selects which limits are enforced. "Altitude ceiling" and "circle" are the usual pair. "Polygon zones" uses the allowed and forbidden areas you drew in the mission planner.'),
          bits: [
            { bit: 0, label: L('Yükseklik tavanı', 'Altitude ceiling') },
            { bit: 1, label: L('Ev çevresinde daire', 'Circle around home') },
            { bit: 2, label: L('Çokgen bölgeler (izinli / yasak alanlar)', 'Polygon zones (inclusion / exclusion)') },
            { bit: 3, label: L('Yükseklik tabanı', 'Altitude floor') },
          ],
          map: [ap(pi('FENCE_TYPE'), { vehicles: [...COPTER, ...PLANE] })],
        },
        {
          id: 'fenceAltMax', kind: 'number', unit: 'm', min: 10, max: 1000, step: 5, gauge: 'altitude',
          title: L('En yüksek irtifa', 'Maximum altitude'),
          desc: L('Aracın kalkış noktasına göre çıkabileceği en büyük yüksekliktir. Tipik değer 100 m; birçok ülkede yasal sınır 120 m\'dir. Dönüş yüksekliğinden büyük olmalıdır, yoksa eve dönüş sırasında çit ihlali oluşur.', 'The greatest height above the launch point the vehicle may reach. Typically 100 m; the legal limit is 120 m in many countries. It must be above the return altitude, or a return will breach the fence.'),
          map: [ap(p('FENCE_ALT_MAX'), { vehicles: [...COPTER, ...PLANE] }), px4(p('GF_MAX_VER_DIST'), { min: 0, max: 1000, zero: L('0: yükseklik sınırı yok', '0: no altitude limit') })],
        },
        {
          id: 'fenceAltMin', kind: 'number', unit: 'm', min: -100, max: 100, step: 1, gauge: 'altitude',
          title: L('En düşük irtifa', 'Minimum altitude'),
          desc: L('Aracın inebileceği en düşük yüksekliktir; yalnızca "yükseklik tabanı" çit türü seçiliyse uygulanır. Yamaçtan kalkıp vadiye doğru uçan araçlar için negatif değer verilebilir. Çoğu kullanıcının buna ihtiyacı yoktur.', 'The lowest height the vehicle may descend to; only enforced when the "altitude floor" fence type is selected. Negative values suit vehicles launched from a hillside and flown down into a valley. Most users do not need it.'),
          map: [ap(p('FENCE_ALT_MIN'), { vehicles: [...COPTER, ...PLANE] })],
        },
        {
          id: 'fenceRadius', kind: 'number', unit: 'm', min: 30, max: 10000, step: 10, gauge: 'radius',
          title: L('En büyük uzaklık (daire yarıçapı)', 'Maximum distance (circle radius)'),
          desc: L('Aracın evden uzaklaşabileceği en büyük mesafedir. Tipik değer 300 m. Aracı gözle görebildiğiniz ve kumanda menzilinizin rahatça yettiği bir mesafe seçin.', 'The furthest the vehicle may go from home. Typically 300 m. Choose a distance at which you can still see the vehicle and that is well within radio range.'),
          map: [ap(p('FENCE_RADIUS')), px4(p('GF_MAX_HOR_DIST'), { min: 0, zero: L('0: uzaklık sınırı yok', '0: no distance limit') })],
        },
        {
          id: 'fenceMargin', kind: 'number', unit: 'm', min: 1, max: 10, step: 0.5, gauge: 'bar',
          ends: [L('Dar', 'Tight'), L('Geniş', 'Wide')],
          title: L('Çit payı', 'Fence margin'),
          desc: L('Araç sınıra bu kadar yaklaşınca çit eylemi başlatılır; böylece fren mesafesi sınırın içinde kalır. Tipik değer 2 m. Hızlı uçuyorsanız payı büyütün.', 'The fence action starts when the vehicle gets this close to the boundary, so the braking distance stays inside it. Typically 2 m. Increase it if you fly fast.'),
          map: [ap(p('FENCE_MARGIN'))],
        },
        {
          id: 'fenceAction', kind: 'select', gauge: null,
          title: L('Çit aşılırsa', 'When the fence is breached'),
          desc: L('Araç sınıra ulaştığında ne yapacağını seçer. "Eve dön" en yaygın seçimdir. "Yalnızca bildir" seçerseniz araç durdurulmaz, sadece uyarı verilir.', 'Chooses what the vehicle does on reaching the boundary. "Return home" is the usual choice. With "Report only" the vehicle is not stopped, you only get a warning.'),
          risk: (v) => (v === 0 ? L('Çit aşıldığında araç durdurulmayacak; yalnızca uyarı verilecek.', 'The vehicle will not be stopped at the fence; only a warning will be given.') : null),
          options: [
            o(0, 'Yalnızca bildir', 'Report only', 'Araç durdurulmaz', 'The vehicle is not stopped'),
            o(1, 'Eve dön, olmazsa in', 'RTL or Land'),
            o(2, 'Her zaman in', 'Always Land'),
            o(3, 'Akıllı eve dönüş, olmazsa RTL ya da in', 'SmartRTL, else RTL or Land'),
            o(4, 'Frenle, olmazsa in', 'Brake or Land'),
            o(5, 'Akıllı eve dönüş, olmazsa in', 'SmartRTL or Land'),
          ],
          map: [
            cop(pi('FENCE_ACTION')),
            px4(pi('GF_ACTION'), {
              risk: (v) => (v === 0 ? L('Çit eylemi kapatılıyor: sınır aşılsa bile araç hiçbir şey yapmaz.', 'The fence action is being turned off: the vehicle does nothing even when the limit is crossed.') : v === 4 ? L('"Uçuşu sonlandır" havadaki aracın motorlarını durdurur; araç düşer.', '"Terminate" stops the motors of an airborne vehicle; it will fall.') : null),
              options: [
                o(0, 'Hiçbir şey yapma', 'None'),
                o(1, 'Yalnızca uyar', 'Warning'),
                o(2, 'Havada bekle', 'Hold'),
                o(3, 'Eve dön', 'Return'),
                o(4, 'Uçuşu sonlandır', 'Terminate', 'Tehlikeli: araç düşer', 'Dangerous: the vehicle falls'),
                o(5, 'İn', 'Land'),
              ],
            }),
          ],
        },
      ],
    },

    // ============================== KUMANDA HİSSİ ==============================
    {
      id: 'feel', icon: 'swap', title: L('Kumanda hissi', 'Pilot feel'),
      intro: L('Çubuklara verdiğiniz komutlara aracın nasıl tepki vereceğini belirler: tepkinin yumuşaklığı, dönüş hızları ve gaz çubuğunun davranışı. Bu ayarlar aracın dengesini (PID) değiştirmez; yalnızca komutları yorumlama biçimini değiştirir.', 'Controls how the vehicle responds to your stick inputs: how smooth the response is, the turn rates and how the throttle stick behaves. These settings do not change the stabilisation (PID) tuning, only how commands are interpreted.'),
      settings: [
        {
          id: 'inputSmooth', kind: 'number', unit: 's', min: 0, max: 1, step: 0.01, gauge: 'bar',
          ends: [L('Keskin', 'Crisp'), L('Yumuşak', 'Soft')],
          title: L('Komut yumuşatma', 'Input smoothing'),
          desc: L('Çubuk hareketlerinin araca ne kadar yumuşatılarak iletileceğini belirler. Tipik değer 0,15 s. Yüksek değer (0,3) çekim için akıcı ve yumuşak, düşük değer (0,05–0,1) yarış ve akrobasi için keskin ve anında tepki verir.', 'How much stick movements are smoothed before reaching the vehicle. Typically 0.15 s. A high value (0.3) is fluid and soft for filming, a low one (0.05–0.1) is crisp and immediate for racing and aerobatics.'),
          map: [cop(p('ATC_INPUT_TC'))],
        },
        {
          id: 'pilotYawRate', kind: 'number', unit: '°/s', min: 10, max: 360, step: 2.5, gauge: 'rate',
          title: L('Kendi ekseninde dönüş hızı', 'Yaw rate'),
          desc: L('Dönüş (yaw) çubuğu sonuna kadar itildiğinde aracın kendi ekseni çevresinde saniyede kaç derece döneceğini belirler. Tipik değer 200 °/s; 360 °/s saniyede bir tam tur demektir. Çekim için 60–90 °/s daha yumuşak kaydırmalar sağlar.', 'How many degrees per second the vehicle spins around its own axis with the yaw stick fully deflected. Typically 200 °/s; 360 °/s is one full turn per second. For filming 60–90 °/s gives smoother pans.'),
          map: [cop(p('PILOT_Y_RATE')), px4mc(p('MPC_MAN_Y_MAX'), { min: 10, max: 400, step: 5 })],
        },
        {
          id: 'pilotYawExpo', kind: 'number', unit: '', min: -0.5, max: 1, step: 0.05, gauge: 'bar',
          ends: [L('Doğrusal', 'Linear'), L('Ortası yumuşak', 'Soft centre')],
          title: L('Dönüş çubuğu eğrisi (expo)', 'Yaw stick curve (expo)'),
          desc: L('Dönüş çubuğunun orta bölgesinin ne kadar hassas olacağını belirler. 0 doğrusal demektir: çubuk ne kadar itilirse o oranda döner. Değer büyüdükçe ortadaki küçük hareketler daha az, uçlardaki hareketler daha çok etki eder; ince düzeltmeler kolaylaşır.', 'How sensitive the centre of the yaw stick is. 0 is linear: rotation is proportional to deflection. Larger values make small movements near the centre do less and movements near the ends do more, easing fine corrections.'),
          map: [cop(p('PILOT_Y_EXPO')), px4mc(p('MPC_YAW_EXPO'), { min: 0, max: 1 })],
        },
        {
          id: 'manualLean', kind: 'number', unit: '°', min: 5, max: 90, step: 1, gauge: 'angle',
          title: L('Elle uçuşta en büyük yatış', 'Maximum lean in manual flight'),
          desc: L('Elle uçuş kiplerinde çubuk sonuna kadar itildiğinde aracın yatacağı açıdır. Tipik değer 35°. Düşük değer yeni başlayanlar için aracı sakinleştirir; yüksek değer hız ve çeviklik kazandırır.', 'The lean angle at full stick deflection in manual flight modes. Typically 35°. A low value calms the vehicle for beginners; a high one adds speed and agility.'),
          map: [px4mc(p('MPC_MAN_TILT_MAX'))],
        },
        {
          id: 'pilotAccelZ', kind: 'number', unit: 'm/s²', min: 0.5, max: 5, step: 0.1, gauge: 'bar',
          ends: [L('Yumuşak', 'Gentle'), L('Atak', 'Aggressive')],
          title: L('Dikey hızlanma (ivme)', 'Vertical acceleration'),
          desc: L('Gaz çubuğunu oynattığınızda aracın tırmanma ya da alçalma hızına ne kadar çabuk ulaşacağını belirler. Tipik değer 2,5 m/s². Düşük değer irtifa değişimlerini yumuşatır; yüksek değer aracı gaz çubuğuna karşı daha canlı yapar.', 'How quickly the vehicle reaches its climb or descent speed when you move the throttle stick. Typically 2.5 m/s². Low values soften altitude changes; high values make the vehicle livelier on the throttle.'),
          map: [cop(pi('PILOT_ACCEL_Z', 100)), px4mc(p('MPC_ACC_UP_MAX'), { min: 2, max: 15 })],
        },
        {
          id: 'thrFilter', kind: 'number', unit: 'Hz', min: 0, max: 10, step: 0.5, gauge: 'bar',
          ends: [L('Kapalı', 'Off'), L('10 Hz', '10 Hz')],
          zero: L('0: süzgeç kapalı', '0: filter off'),
          title: L('Gaz çubuğu süzgeci', 'Throttle stick filter'),
          desc: L('Elle gaz verilen kiplerde (Stabilize, Akro) gaz çubuğundaki ani ve titrek hareketleri yumuşatır. 0 süzgeci kapatır. 2–5 Hz arası bir değer, gaza sert basan pilotlar için kalkışı ve irtifa tutmayı kolaylaştırır.', 'Smooths abrupt, jittery throttle movements in manual-throttle modes (Stabilize, Acro). 0 turns the filter off. A value of 2–5 Hz makes takeoff and holding height easier for heavy-handed pilots.'),
          map: [cop(p('PILOT_THR_FILT'))],
        },
        {
          id: 'thrDeadzone', kind: 'number', unit: 'PWM', min: 0, max: 300, step: 5, gauge: 'bar',
          ends: [L('Dar', 'Narrow'), L('Geniş', 'Wide')],
          title: L('Gaz çubuğu ölü bölgesi', 'Throttle deadzone'),
          desc: L('İrtifa tutmalı kiplerde gaz çubuğunun ortasında, aracın yüksekliğini koruduğu bölgenin genişliğidir. Tipik değer 100. Geniş bölge çubuğu tam ortada tutma zorunluluğunu azaltır; dar bölge irtifayı daha hassas yönetmenizi sağlar.', 'The width of the zone around mid-stick in which the vehicle holds its height in altitude-holding modes. Typically 100. A wide zone means you need not hold the stick exactly centred; a narrow one gives finer altitude control.'),
          map: [cop(pi('THR_DZ'))],
        },
        {
          id: 'thrBehavior', kind: 'bits', gauge: null,
          title: L('Gaz çubuğu davranışı', 'Throttle stick behaviour'),
          desc: L('Gaz çubuğunun bazı özel davranışlarını açar. Yaylı (kendiliğinden ortaya dönen) gaz çubuğu olan kumandalarda "orta noktadan geri bildirim" seçeneği gereklidir. Diğerleri iniş sırasındaki davranışı değiştirir.', 'Enables some special throttle-stick behaviours. Radios with a spring-centred throttle stick need the "feedback from mid stick" option. The others change the behaviour during landing.'),
          bits: [
            { bit: 0, label: L('Orta noktadan geri bildirim (yaylı gaz çubuğu için)', 'Feedback from mid stick (for spring-centred throttle)') },
            { bit: 1, label: L('Yüksek gaz, otomatik inişi iptal eder', 'High throttle cancels an automatic landing') },
            { bit: 2, label: L('İniş algılanınca motorları hemen kapat', 'Disarm as soon as landing is detected') },
          ],
          map: [cop(pi('PILOT_THR_BHV'))],
        },
        {
          id: 'armingRudder', kind: 'select', gauge: null,
          title: L('Çubukla motor kurma', 'Arming with the stick'),
          desc: L('Motorların dönüş (yaw) çubuğuyla kurulup kapatılabilmesini ayarlar: gaz en altta, çubuk sağa → kur; sola → kapat. Kapatmayı devre dışı bırakırsanız havada yanlışlıkla motor kapatma riski kalkar ama motorları başka yolla (anahtar ya da yer istasyonu) kapatmanız gerekir.', 'Sets whether the motors can be armed and disarmed with the yaw stick: throttle down, stick right → arm; left → disarm. Disabling the disarm part removes the risk of an accidental in-air disarm, but you must then disarm another way (switch or ground station).'),
          options: [
            o(0, 'Kapalı', 'Disabled', 'Yalnızca anahtar ya da yer istasyonu', 'Switch or ground station only'),
            o(1, 'Yalnızca kurma', 'Arm only'),
            o(2, 'Kurma ve kapatma', 'Arm and disarm'),
          ],
          map: [ap(pi('ARMING_RUDDER'))],
        },
        {
          id: 'acroRate', kind: 'number', unit: '°/s', min: 10, max: 1080, step: 10, gauge: 'rate',
          title: L('Akro: yatış / yunuslama hızı', 'Acro: roll / pitch rate'),
          desc: L('Akro kipinde çubuk sonuna kadar itildiğinde aracın saniyede kaç derece döneceğini belirler. Tipik değer 360 °/s (saniyede bir takla). Akro kipinde araç kendini düzeltmez; yalnızca deneyimli pilotlar içindir.', 'How many degrees per second the vehicle rotates at full stick in Acro mode. Typically 360 °/s (one flip per second). The vehicle does not self-level in Acro; it is for experienced pilots only.'),
          map: [cop(p('ACRO_RP_RATE'))],
        },
        {
          id: 'acroYawRate', kind: 'number', unit: '°/s', min: 10, max: 360, step: 2.5, gauge: 'rate',
          title: L('Akro: dönüş hızı', 'Acro: yaw rate'),
          desc: L('Akro kipinde dönüş (yaw) çubuğu sonuna kadar itildiğinde aracın kendi ekseninde saniyede kaç derece döneceğini belirler. Tipik değer 200 °/s.', 'How many degrees per second the vehicle yaws at full stick in Acro mode. Typically 200 °/s.'),
          map: [cop(p('ACRO_Y_RATE'))],
        },
        {
          id: 'acroExpo', kind: 'number', unit: '', min: -0.5, max: 0.95, step: 0.05, gauge: 'bar',
          ends: [L('Doğrusal', 'Linear'), L('Ortası yumuşak', 'Soft centre')],
          title: L('Akro: çubuk eğrisi (expo)', 'Acro: stick curve (expo)'),
          desc: L('Akro kipinde çubukların orta bölgesinin ne kadar hassas olacağını belirler. Tipik değer 0,3. Değer büyüdükçe ortadaki küçük hareketler daha yumuşak, uçlardaki hareketler daha sert etki eder.', 'How sensitive the stick centre is in Acro mode. Typically 0.3. Larger values make small movements near the centre gentler and movements near the ends stronger.'),
          map: [cop(p('ACRO_RP_EXPO'))],
        },
        {
          id: 'acroTrainer', kind: 'select', gauge: null,
          title: L('Akro: eğitim yardımı', 'Acro: trainer'),
          desc: L('Akro kipini öğrenirken yardımcı olur. "Düzeltme" çubukları bıraktığınızda aracı yavaşça düze getirir. "Düzeltme ve açı sınırı" ayrıca aracın en büyük yatış açısını aşmasını engeller; öğrenirken en güvenli seçenek budur.', 'Helps while learning Acro mode. "Levelling" slowly levels the vehicle when you release the sticks. "Levelling and angle limit" also stops it exceeding the maximum lean angle; this is the safest option while learning.'),
          options: [
            o(0, 'Kapalı', 'Disabled', 'Tam akro', 'Full acro'),
            o(1, 'Düzeltme', 'Levelling'),
            o(2, 'Düzeltme ve açı sınırı', 'Levelling and angle limit'),
          ],
          map: [cop(pi('ACRO_TRAINER'))],
        },
      ],
    },

    // ============================== UÇUŞ KİPLERİ ==============================
    {
      id: 'modes', icon: 'layers', title: L('Uçuş kipleri', 'Flight modes'),
      intro: L('Kumandadaki kip anahtarının her konumunda aracın hangi uçuş kipine geçeceğini belirler. Anahtar altı konuma kadar destekler; her konum, kip kanalındaki bir sinyal aralığına karşılık gelir. Konumlardan en az birine "Eve dön" (RTL) ve birine konum tutmalı bir kip (Loiter) atamanız önerilir.', 'Sets which flight mode each position of the mode switch on the radio selects. The switch supports up to six positions, each corresponding to a signal range on the mode channel. Assigning "Return" (RTL) to at least one position and a position-holding mode (Loiter) to another is recommended.'),
      settings: [
        {
          id: 'fltmodeCh', kind: 'select', gauge: null,
          title: L('Kip anahtarı kanalı', 'Mode switch channel'),
          desc: L('Kumandada uçuş kipi anahtarının bağlı olduğu kanaldır. Çoğu kurulumda 5. kanaldır. Yanlış kanal seçerseniz anahtar kip değiştirmez.', 'The radio channel the flight-mode switch is on. It is channel 5 in most setups. With the wrong channel the switch will not change modes.'),
          options: [o(0, 'Kapalı', 'Disabled'), o(5, 'Kanal 5', 'Channel 5'), o(6, 'Kanal 6', 'Channel 6'), o(7, 'Kanal 7', 'Channel 7'), o(8, 'Kanal 8', 'Channel 8')],
          map: [cop(pi('FLTMODE_CH'))],
        },
        ...[
          ['≤ 1230', 'ilk', 'first'], ['1231 – 1360', 'ikinci', 'second'], ['1361 – 1490', 'üçüncü', 'third'],
          ['1491 – 1620', 'dördüncü', 'fourth'], ['1621 – 1749', 'beşinci', 'fifth'], ['≥ 1750', 'altıncı', 'sixth'],
        ].map(([pwm, ordTr, ordEn], i) => ({
          id: `fltmode${i + 1}`, kind: 'select', gauge: 'switch', position: i + 1, pwm, options: 'modes',
          title: L(`Anahtar konumu ${i + 1}`, `Switch position ${i + 1}`),
          desc: L(`Kip anahtarı ${ordTr} konumdayken (kanal sinyali ${pwm}) aracın geçeceği uçuş kipidir.${i === 0 ? ' İki ya da üç konumlu anahtarlar genelde 1., 4. ve 6. konumları kullanır.' : ''}${i === 5 ? ' Anahtarın en uç konumuna "Eve dön" (RTL) atamak, panik anında kolay bulunur.' : ''}`, `The flight mode selected when the mode switch is in its ${ordEn} position (channel signal ${pwm}).${i === 0 ? ' Two- and three-position switches usually use positions 1, 4 and 6.' : ''}${i === 5 ? ' Putting "Return" (RTL) on the end position makes it easy to find in a panic.' : ''}`),
          map: [
            ap(pi(`FLTMODE${i + 1}`)),
            rover(pi(`MODE${i + 1}`)),
            px4(pi(`COM_FLTMODE${i + 1}`), { pwm: null, options: [
              o(-1, 'Atanmamış', 'Unassigned'), o(0, 'Manual', 'Manual'), o(1, 'Altitude', 'Altitude'), o(2, 'Position', 'Position'), o(3, 'Mission', 'Mission'),
              o(4, 'Hold', 'Hold'), o(5, 'Return', 'Return'), o(6, 'Acro', 'Acro'), o(7, 'Offboard', 'Offboard'), o(8, 'Stabilized', 'Stabilized'),
              o(10, 'Takeoff', 'Takeoff'), o(11, 'Land', 'Land'), o(12, 'Follow Me', 'Follow Me'), o(13, 'Precision Land', 'Precision Land'),
            ] }),
          ],
        })),
      ],
    },
  ];

  // ---- Saf yardımcılar ----
  function r6(v) { return Number(Number(v).toFixed(6)); }
  const same = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-6 * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b)));
  const decimals = (step) => { const s = String(step || 1); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };

  // Arayüz dili Türkçe ise tr, değilse en
  function text(obj, lang) {
    if (obj === null || obj === undefined) return '';
    if (typeof obj === 'string') return obj;
    return (lang === 'tr' ? obj.tr : obj.en) || obj.en || obj.tr || '';
  }

  // Araca uyan ilk eşleme: yazılım ve araç türü tutmalı, zorunlu parametrelerin hepsi araçta bulunmalı
  function resolve(setting, ctx) {
    const c = ctx || {};
    const has = c.has || (() => false);
    for (const m of setting.map || []) {
      if (m.fw !== c.firmware) continue;
      if (m.vehicles && !m.vehicles.includes(c.vehicle || 'copter')) continue;
      if (!m.params.length || !m.params.every((x) => has(typeof x === 'string' ? x : x.name))) continue;
      return m;
    }
    return null;
  }

  // Ayarın bu araçtaki görünümü: eşleme; aralığı, seçenekleri, açıklamayı ve sıfır notunu değiştirebilir
  function view(setting, mapping, ctx) {
    const v = { ...setting };
    for (const k of ['min', 'max', 'step', 'options', 'desc', 'zero', 'risk', 'unit', 'pwm']) if (mapping && mapping[k] !== undefined) v[k] = mapping[k];
    if (v.options === 'modes') v.options = ((ctx && ctx.modes) || []).map((m) => ({ value: m.id, label: L(m.name, m.name) }));
    delete v.map;
    return v;
  }

  const toParam = (x, value) => { const raw = r6(Number(value) * (x.scale || 1) + (x.offset || 0)); return x.round ? Math.round(raw) : raw; };

  // Parametre değerlerinden kullanıcı düzeyindeki değer (sayı / seçenek değeri / true-false / bit maskesi / hazır takım adı)
  function read(setting, mapping, get) {
    if (!mapping) return null;
    if (setting.kind === 'preset') {
      for (const [key, bundle] of Object.entries(mapping.bundles || {})) {
        const names = Object.keys(bundle).filter((n) => get(n) !== undefined);
        if (names.length && names.every((n) => same(get(n), bundle[n]))) return key;
      }
      return null;
    }
    const x = mapping.params[0];
    const raw = get(x.name);
    if (raw === undefined || raw === null) return null;
    if (setting.kind === 'toggle') return !same(raw, x.off !== undefined ? x.off : 0);
    if (setting.kind === 'bits') return Number(raw) >>> 0;
    const v = (Number(raw) - (x.offset || 0)) / (x.scale || 1);
    return setting.kind === 'select' ? Math.round(v) : Number(v.toFixed(4));
  }

  // Değer için yazılacak parametreler: [{ name, value, from, why? }]. Bağlı (linked) yazımlar eklenir, aynı ada
  // ikinci yazım atılır, araçta bulunmayan ya da değeri zaten aynı olan parametreler atlanır.
  function plan(setting, mapping, value, get) {
    if (!mapping || value === null || value === undefined) return [];
    const wanted = [];
    if (setting.kind === 'preset') {
      for (const [name, v] of Object.entries((mapping.bundles || {})[value] || {})) wanted.push({ name, value: v });
    } else if (setting.kind === 'toggle') {
      for (const x of mapping.params) {
        const on = x.on !== undefined ? x.on : 1; const off = x.off !== undefined ? x.off : 0;
        const cur = get(x.name);
        // Açıkken farklı bir "açık" değeri (ör. ARMING_CHECK bit maskesi) varsa ona dokunulmaz
        if (value && cur !== undefined && !same(cur, off)) continue;
        wanted.push({ name: x.name, value: value ? on : off });
      }
    } else if (setting.kind === 'bits') {
      for (const x of mapping.params) wanted.push({ name: x.name, value: Number(value) >>> 0 });
    } else {
      for (const x of mapping.params) wanted.push({ name: x.name, value: toParam(x, value) });
    }
    if (typeof mapping.linked === 'function') for (const w of mapping.linked(value, get) || []) wanted.push(w);
    const seen = new Set();
    const out = [];
    for (const w of wanted) {
      if (seen.has(w.name)) continue;
      seen.add(w.name);
      const from = get(w.name);
      if (from === undefined || from === null || same(from, w.value)) continue;
      out.push({ name: w.name, value: w.value, from, ...(w.why ? { why: w.why } : {}) });
    }
    return out;
  }

  // Eşlemenin okuduğu / yazabileceği bütün parametre adları (değişiklikleri izlemek ve aramak için)
  function paramNames(setting, mapping) {
    if (!mapping) return [];
    const s = new Set(mapping.params.map((x) => (typeof x === 'string' ? x : x.name)));
    for (const b of Object.values(mapping.bundles || {})) for (const n of Object.keys(b)) s.add(n);
    return [...s];
  }

  // Değerin gerektirdiği güvenlik uyarısı ({tr,en}) ya da null
  function risk(setting, mapping, value) {
    const fn = (mapping && mapping.risk) || setting.risk;
    return typeof fn === 'function' ? fn(value) || null : null;
  }

  // İki kullanıcı düzeyi değer aynı mı (sayılarda kayan nokta payıyla)
  function equal(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return same(a, b);
    return false;
  }

  function clamp(v, value) {
    let n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Number.isFinite(v.min)) n = Math.max(v.min, n);
    if (Number.isFinite(v.max)) n = Math.min(v.max, n);
    return Number(n.toFixed(Math.max(decimals(v.step), 0) + 2));
  }

  // Araca uyan gruplar: [{ id, icon, title, intro, items: [{ setting, mapping, view }] }] (boş gruplar atılır)
  function available(ctx) {
    const out = [];
    for (const g of GROUPS) {
      const items = [];
      for (const s of g.settings) { const m = resolve(s, ctx); if (m) items.push({ setting: s, mapping: m, view: view(s, m, ctx) }); }
      if (items.length) out.push({ id: g.id, icon: g.icon, title: g.title, intro: g.intro, items });
    }
    return out;
  }

  // Arama: başlık, açıklama (iki dilde), seçenek adları ve parametre adları
  function matches(item, query) {
    const q = String(query || '').trim().toLocaleLowerCase('tr');
    if (!q) return true;
    const v = item.view;
    const hay = [v.title.tr, v.title.en, v.desc.tr, v.desc.en, ...paramNames(item.setting, item.mapping),
      ...(Array.isArray(v.options) ? v.options.flatMap((x) => [x.label.tr, x.label.en]) : []), ...(v.bits || []).flatMap((b) => [b.label.tr, b.label.en])];
    return hay.some((s) => String(s).toLocaleLowerCase('tr').includes(q) || String(s).toLowerCase().includes(q.toLowerCase()));
  }

  // Batarya hücre sayısı kestirimi: en yüksek batarya gerilimi (MOT_BAT_VOLT_MAX) biliniyorsa ondan, yoksa eşik geriliminden
  function cells(volts, get) {
    const max = get ? Number(get('MOT_BAT_VOLT_MAX')) : NaN;
    if (Number.isFinite(max) && max > 0) return Math.max(1, Math.round(max / 4.2));
    const v = Number(volts);
    return Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v / 3.55)) : 0;
  }

  const all = () => GROUPS.flatMap((g) => g.settings);
  const api = { GROUPS, UI, text, resolve, view, read, plan, paramNames, risk, equal, clamp, available, matches, cells, decimals, all };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TUNING = api;
})(typeof self !== 'undefined' ? self : this);
