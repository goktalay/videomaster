// Yapay görü çalışma zamanı (onnxruntime-web, yalnızca WASM) src/vendor/ort içine kopyalanır.
// npm install / npm ci sonrasında kendiliğinden çalışır; kurulum paketine yalnızca bu üç dosya girer.
const fs = require('fs');
const path = require('path');
const from = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const to = path.join(__dirname, '..', 'src', 'vendor', 'ort');
if (!fs.existsSync(from)) { console.log('vendor: onnxruntime-web kurulu değil, atlandı'); process.exit(0); }
fs.mkdirSync(to, { recursive: true });
for (const f of ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log('vendor: onnxruntime-web → src/vendor/ort');
// Harita (uçuş penceresi): MapLibre GL JS, CSP uyumlu derleme (işçi ayrı dosya)
const mapFrom = path.join(__dirname, '..', 'node_modules', 'maplibre-gl', 'dist');
const mapTo = path.join(__dirname, '..', 'src', 'vendor', 'maplibre');
if (fs.existsSync(mapFrom)) {
  fs.mkdirSync(mapTo, { recursive: true });
  for (const f of ['maplibre-gl-csp.js', 'maplibre-gl-csp-worker.js', 'maplibre-gl.css']) fs.copyFileSync(path.join(mapFrom, f), path.join(mapTo, f));
  console.log('vendor: maplibre-gl → src/vendor/maplibre');
}
