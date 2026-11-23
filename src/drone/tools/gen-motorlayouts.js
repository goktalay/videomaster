'use strict';

// ArduPilot'un resmî motor yerleşim tablosunu (AP_Motors testinin ürettiği APMotorLayout.json; Mission Planner ile de dağıtılır)
// arayüzün çizebileceği src/drone/motorlayouts.json dosyasına çevirir. Çalışma zamanında kullanılmaz.
//   node src/drone/tools/gen-motorlayouts.js [APMotorLayout.json yolu]   (yol verilmezse GitHub'dan indirir)
// Dönüşüm: x = −Roll (sağ +), y = Pitch (ileri +); her yerleşim en büyük |x|,|y| değeri 1 olacak biçimde ölçeklenir.
// (ArduPilot'ta artı roll çarpanı motorun solda olduğunu, artı pitch çarpanı önde olduğunu gösterir.)

const fs = require('fs');
const path = require('path');

const URL = 'https://raw.githubusercontent.com/ArduPilot/MissionPlanner/master/APMotorLayout.json';
const OUT = path.join(__dirname, '..', 'motorlayouts.json');

async function main() {
  const src = process.argv[2];
  const text = src ? fs.readFileSync(src, 'utf8') : await (await fetch(URL)).text();
  const data = JSON.parse(text);
  const round = (v) => Math.round(v * 1000) / 1000 + 0; // −0 → 0
  const layouts = data.layouts.map((l) => {
    const max = Math.max(...l.motors.map((m) => Math.max(Math.abs(m.Roll), Math.abs(m.Pitch)))) || 1;
    return {
      class: l.Class,
      type: l.Type,
      className: l.ClassName,
      typeName: l.TypeName,
      name: `${l.ClassName} ${l.TypeName}`,
      motors: l.motors.map((m) => ({
        n: m.Number,
        testOrder: m.TestOrder,
        x: round(-m.Roll / max),
        y: round(m.Pitch / max),
        dir: /^ccw$/i.test(m.Rotation) ? 'ccw' : /^cw$/i.test(m.Rotation) ? 'cw' : null,
      })),
    };
  });
  const json = '{\n"source":' + JSON.stringify(data.Version) + ',\n"layouts":[\n' + layouts.map((l) => JSON.stringify(l)).join(',\n') + '\n]\n}\n';
  fs.writeFileSync(OUT, json);
  console.log(`${OUT}: ${layouts.length} yerleşim`);
}

main().catch((err) => { console.error(err); process.exit(1); });
