// build/icon.svg dosyasından icon.png (512) ve çok boyutlu icon.ico üretir.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'));

(async () => {
  await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(path.join(root, 'build', 'icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
  const ico = await (pngToIco.default || pngToIco)(pngs);
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico);
  console.log('icon.png ve icon.ico oluşturuldu');
})();
