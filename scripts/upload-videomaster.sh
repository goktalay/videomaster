#!/usr/bin/env bash
# Exe'leri videomaster.app'a yükler (Mastertool sözleşmesi v1, §4).
# Kullanım: upload-videomaster.sh <sürüm> <setup.exe> [notlar] [portable.exe]
# Anahtar VIDEOM_RELEASE_KEY ortam değişkeninden okunur; tanımlı değilse uyarı verip çıkar.
#
# Her dosya ayrı istekle ve ≤ 90 MB parçalar halinde gönderilir: sunucunun önündeki Cloudflare
# tek istekte 100 MB üstünü reddeder (413).
#   Kurulum:  POST /api/vm/releases/<sürüm>/setup     (zorunlu; sürüm kaydını oluşturur)
#   Portable: POST /api/vm/releases/<sürüm>/portable  (isteğe bağlı; başarısızsa yayın sürer)
# 409 exists → zaten yüklü, atlanır. Son parçanın yanıtındaki sha256 yerel dosyayla karşılaştırılır.
set -euo pipefail

VERSION="$1"
SETUP="$2"
NOTES="${3:-}"
PORTABLE="${4:-}"
[ -n "$NOTES" ] || NOTES="Video Master $VERSION"
BASE="${VIDEOM_API:-https://videomaster.app}"
# videomaster.app DNS'i hazır değilse aynı API mastertool.download'da da var
if [ -z "${VIDEOM_API:-}" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/vm/releases/latest" || true)" = "000" ]; then
  echo "::notice::$BASE erişilemedi; https://mastertool.download kullanılıyor."
  BASE="https://mastertool.download"
fi
API="$BASE/api/vm/releases"
PART_BYTES="${VIDEOM_PART_BYTES:-90000000}"     # test için küçültülebilir

if [ -z "${VIDEOM_RELEASE_KEY:-}" ]; then
  echo "::warning::VIDEOM_RELEASE_KEY tanımlı değil; videomaster.app'a yükleme atlandı."
  exit 0
fi

post() { # post <url> <curl -F argümanları...>  → HTTP kodu; gövde response.json'a
  local url="$1"; shift
  curl -sS -o response.json -w '%{http_code}' -X POST "$url" -H "X-Release-Key: $VIDEOM_RELEASE_KEY" "$@"
}

# Dosyayı ≤ PART_BYTES parçalar halinde sırayla gönderir; son HTTP kodunu yazdırır
post_parts() { # post_parts <url> <dosya> <dosya adı> [ek -F argümanları...]
  local url="$1" file="$2" name="$3"; shift 3
  # Göreli geçici klasör: Windows'taki curl, Git Bash'in /tmp yollarını okuyamaz
  local dir; dir=$(mktemp -d ./.cvm-parts.XXXXXX)
  split -b "$PART_BYTES" -d -a 3 "$file" "$dir/part."
  local parts=( "$dir"/part.* ) total=${#parts[@]} i=0 code=""
  for p in "${parts[@]}"; do
    code=$(post "$url" -F "file=@$p;filename=$name" -F "part=$i" -F "parts=$total" -F "filename=$name" "$@")
    echo "  parça $((i + 1))/$total → HTTP $code $(cat response.json)" >&2
    case "$code" in 200|201) ;; *) break ;; esac
    i=$((i + 1))
  done
  rm -rf "$dir"
  echo "$code"
}

# Sunucunun bildirdiği sha256'yı yerel dosyayla karşılaştırır
verify() { # verify <dosya>
  local want got
  want=$(sha256sum "$1" | cut -d' ' -f1)
  got=$(sed -n 's/.*"sha256": *"\([0-9a-fA-F]*\)".*/\1/p' response.json | tr 'A-F' 'a-f')
  if [ -z "$got" ]; then echo "::warning::Sunucu yanıtında sha256 yok; doğrulanamadı."; return 0; fi
  if [ "$got" = "$want" ]; then echo "  sha256 doğrulandı: $want"; else echo "::error::sha256 uyuşmuyor (yerel $want, sunucu $got)"; return 1; fi
}

# --- Kurulum ------------------------------------------------------------------
echo "Kurulum: $SETUP ($(stat -c %s "$SETUP") bayt), sürüm $VERSION"
HTTP=$(post_parts "$API/$VERSION/setup" "$SETUP" "$(basename "$SETUP")" -F "notes=$NOTES")
case "$HTTP" in
  200|201) echo "$BASE: kurulum $VERSION yüklendi."; verify "$SETUP" ;;
  409) echo "::notice::videomaster.app'da $VERSION kurulumu zaten var (409); atlandı." ;;
  *) echo "::error::Kurulum yüklemesi başarısız (HTTP $HTTP)."; exit 1 ;;
esac

# --- Portable (isteğe bağlı) ----------------------------------------------------
if [ -n "$PORTABLE" ] && [ -f "$PORTABLE" ]; then
  echo "Portable: $PORTABLE ($(stat -c %s "$PORTABLE") bayt)"
  HTTP=$(post_parts "$API/$VERSION/portable" "$PORTABLE" "$(basename "$PORTABLE")") || HTTP=000
  case "$HTTP" in
    200|201) echo "$BASE: portable $VERSION yüklendi."; verify "$PORTABLE" || true ;;
    409) echo "::notice::videomaster.app'da $VERSION portable zaten var (409); atlandı." ;;
    *) echo "::warning::Portable yüklemesi başarısız (HTTP $HTTP); kurulum yüklendiği için yayın sürüyor." ;;
  esac
fi
