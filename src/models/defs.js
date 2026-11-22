// Kamera modeli tanımlarının listesi. Ana süreçte require ile, pencerelerde <script> ile yüklenen
// model dosyalarından (window.CAMERA_MODELS) toplanır. Yeni model: tanım dosyasını buraya ve
// pencerelerdeki (index.html, viewer.html) <script> listesine ekleyin; sürücüsünü index.js'e ekleyin.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const list = isNode
    ? [require('./cpdd075cct'), ...require('./skydroid')]
    : Object.values(root.CAMERA_MODELS || {});
  if (isNode) module.exports = list;
  else root.CAMERA_MODEL_LIST = list;
})(typeof self !== 'undefined' ? self : this);
