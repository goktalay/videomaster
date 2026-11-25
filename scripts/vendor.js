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
// Harita (uçuş penceresi ve görev düzenleyici): CesiumJS hazır derlemesi — yalnız gerekli parçalar
const csFrom = path.join(__dirname, '..', 'node_modules', 'cesium', 'Build', 'Cesium');
const csTo = path.join(__dirname, '..', 'src', 'vendor', 'cesium');
if (fs.existsSync(csFrom)) {
  fs.rmSync(csTo, { recursive: true, force: true });
  fs.mkdirSync(csTo, { recursive: true });
  fs.copyFileSync(path.join(csFrom, 'Cesium.js'), path.join(csTo, 'Cesium.js'));
  for (const d of ['Assets', 'Workers', 'ThirdParty']) fs.cpSync(path.join(csFrom, d), path.join(csTo, d), { recursive: true });
  console.log('vendor: cesium → src/vendor/cesium');
}
