'use strict';

// Sahte ArduCopter benzetimcisini komut satırından çalıştırır (gerçek dron olmadan uygulamayı denemek için).
//   node scripts/sim-drone.js                                 → UDP 127.0.0.1:14550'ye gönderir + TCP 5760'ı dinler
//   node scripts/sim-drone.js --udp 127.0.0.1:14550 --tcp 5760
//   node scripts/sim-drone.js --udp-listen 14551              → UDP kapısını dinler (uygulamada bağlantı türü "UDP")
// Diğer seçenekler: --sysid 1  --home 39.9255,32.8663[,890]  --drop 3,7,20 (ilk parametre listesinde düşürülecek indeksler)  --quiet
// Uygulamada: bağlantı türü "UDP dinleme" (kapı 14550) ya da "TCP" (127.0.0.1:5760).

const { createSim } = require('../test/sim/vehicle-sim');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Kullanım: node scripts/sim-drone.js [--udp host:port] [--tcp port] [--udp-listen port] [--sysid n] [--home lat,lon[,alt]] [--drop i,j] [--quiet]');
    return;
  }
  const opts = { sysid: Number(args.sysid) || 1 };
  const explicit = args.udp || args.tcp || args['udp-listen'];
  if (args.udp || !explicit) {
    const [host, port] = String(args.udp === true || !args.udp ? '127.0.0.1:14550' : args.udp).split(':');
    opts.udp = { host: port ? host : '127.0.0.1', port: Number(port || host) || 14550 };
  }
  if (args.tcp || !explicit) opts.tcp = Number(args.tcp === true || !args.tcp ? 5760 : args.tcp) || 5760;
  if (args['udp-listen']) opts.udpListen = Number(args['udp-listen'] === true ? 14551 : args['udp-listen']) || 14551;
  if (args.home) {
    const [lat, lon, alt] = String(args.home).split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) opts.home = { lat, lon, ...(Number.isFinite(alt) ? { alt } : {}) };
  }
  if (args.drop) opts.dropParams = String(args.drop).split(',').map(Number).filter(Number.isFinite);
  opts.tcpHost = '0.0.0.0';
  opts.udpHost = '0.0.0.0';

  const sim = createSim(opts);
  await sim.start();
  console.log(`Sahte ArduCopter çalışıyor (sysid ${opts.sysid}, ${sim.params.size} parametre)`);
  if (opts.udp) console.log(`  UDP → ${opts.udp.host}:${opts.udp.port}   (uygulamada: UDP dinleme, kapı ${opts.udp.port})`);
  if (sim.tcpPort) console.log(`  TCP sunucu :${sim.tcpPort}          (uygulamada: TCP 127.0.0.1:${sim.tcpPort})`);
  if (sim.udpPort) console.log(`  UDP dinleme :${sim.udpPort}        (uygulamada: UDP 127.0.0.1:${sim.udpPort})`);
  console.log('Durdurmak için Ctrl+C');

  if (!args.quiet) {
    let shown = 0;
    setInterval(() => {
      while (shown < sim.calls.length) {
        const c = sim.calls[shown++];
        if (c.name === 'REQUEST_DATA_STREAM' || c.name === 'MAV_CMD_SET_MESSAGE_INTERVAL' || c.name === 'PARAM_REQUEST_READ') continue;
        console.log(`  ← ${c.name} ${JSON.stringify(c.params)}`);
      }
    }, 250);
  }
  const quit = () => { sim.stop().then(() => process.exit(0), () => process.exit(0)); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
