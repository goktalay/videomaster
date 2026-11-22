'use strict';

// Mastertool düğmesi: üst çubuğun en sağına yerleşir, mastertool.download'u tarayıcıda açar.
// Adres (dil ve gece/gündüz teması) ana süreçte kurulur; işaretleme web siteleriyle birebir aynıdır.

function mastertoolButton() {
  const a = h(`<a class="mtk-mt" href="https://mastertool.download/" title="Mastertool — SSH Master · FTP Masters · SQL Master · Notepad Master · Convert Master · Video Master">
    <span class="mtk-mt-in">
      <svg class="mtk-mt-ic" viewBox="0 0 32 32" aria-hidden="true">
        <defs><linearGradient id="mtkg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
        <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#mtkg)"/>
        <path d="M8.5 22.5V10l7.5 7.5 7.5-7.5v12.5" fill="none" stroke="#06101c" stroke-opacity=".28" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <path class="mtk-mt-m" d="M8.5 22.5V10l7.5 7.5 7.5-7.5v12.5" fill="none" stroke="#06101c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="100"/>
      </svg>
      <span class="mtk-mt-tx">Mastertool</span>
      <svg class="mtk-mt-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
  </a>`);
  a.addEventListener('click', (e) => { e.preventDefault(); window.api.openMastertool(); });
  return a;
}

// Kapsayıcının en sonuna (sağ köşe) ekler
function mountMastertool(container) {
  container.appendChild(mastertoolButton());
}
