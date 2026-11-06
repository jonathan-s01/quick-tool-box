#!/usr/bin/env bash
# Sets up and starts everything on a Debian or Ubuntu computer (for example a Proxmox LXC).
# Safe to run again at any time: it keeps your settings, data and models, and updates the rest.
#
#   ./setup.sh                  everything on this computer (AI models and apps)
#   ./setup.sh --role llm       only the AI models (llama-swap with llama.cpp)
#   ./setup.sh --role apps --llm-server http://AI-COMPUTER-ADDRESS:8091
#                               only the apps, using AI models on another computer
#   ./setup.sh --retune         work out the llama.cpp tuning again (for example after changing cores or memory)
#   ./setup.sh -y               do not ask questions; use the suggested answers
#   ./setup.sh --no-models      do not download a model
set -euo pipefail
cd "$(dirname "$0")"

ROLE=""
YES=0
RETUNE=0
NO_MODELS=0
LLM_SERVER_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --llm-server) LLM_SERVER_ARG="${2:-}"; shift 2 ;;
    -y|--yes) YES=1; shift ;;
    --retune) RETUNE=1; shift ;;
    --no-models) NO_MODELS=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
ask() { # ask "question" default -> echoes answer
  local q="$1" d="$2" a=""
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then echo "$d"; return; fi
  read -r -p "   $q [$d] " a </dev/tty || true
  echo "${a:-$d}"
}

SUDO=""
if [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null || fail "Run this as root, or install sudo."
  SUDO="sudo"
fi

# ---------------------------------------------------------------- 1. system and Docker
say "Checking this computer"
[ -r /etc/os-release ] && . /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in
  *debian*|*ubuntu*) note "System: ${PRETTY_NAME:-Debian-like}" ;;
  *) note "System: ${PRETTY_NAME:-unknown}. This script is made for Debian or Ubuntu; continuing anyway." ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (from get.docker.com)"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl >/dev/null
  curl -fsSL https://get.docker.com | $SUDO sh
fi
command -v curl >/dev/null || { $SUDO apt-get update -qq; $SUDO apt-get install -y -qq curl >/dev/null; }
$SUDO docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing. Install the docker-compose-plugin package and run ./setup.sh again."
if ! $SUDO docker run --rm hello-world >/dev/null 2>&1; then
  cat >&2 <<'EOF'

Stopped: Docker is installed but cannot start containers.
In a Proxmox LXC this usually means two features are off. On the Proxmox host, open the container,
then Options, Features, and tick "Nesting" and "keyctl". Restart the container and run ./setup.sh again.
EOF
  exit 1
fi
DOCKER="$SUDO docker"

CPUS=$(nproc)
MEM_GB=$(awk '/MemTotal/ { printf "%d", ($2 / 1048576) + 0.5 }' /proc/meminfo)
DISK_GB=$(df -BG --output=avail . | tail -1 | tr -dc 0-9)
AVX2=no; grep -qw avx2 /proc/cpuinfo && AVX2=yes
note "Processor: $CPUS cores available, AVX2: $AVX2. Memory: $MEM_GB GB. Free disk: $DISK_GB GB."
[ "$AVX2" = no ] && note "Without AVX2, llama.cpp is much slower. Check the LXC's CPU type in Proxmox (use \"host\")."
[ "$DISK_GB" -lt 25 ] && note "Warning: less than 25 GB free. The containers alone need about 15 to 20 GB."

# ---------------------------------------------------------------- 2. settings (.env)
say "Settings"
[ -f .env ] || cp .env.example .env

getenv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
setenv() { # setenv KEY VALUE [force]
  local k="$1" v="$2" force="${3:-0}" cur
  cur="$(getenv "$k")"
  if grep -qE "^$k=" .env; then
    if [ -z "$cur" ] || [ "$force" = 1 ]; then
      local tmp; tmp="$(mktemp)"
      awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
    fi
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

CUR_PROFILES="$(getenv COMPOSE_PROFILES)"
if [ -z "$ROLE" ]; then
  case "${CUR_PROFILES%,bus}" in
    llm) ROLE=llm ;;
    apps) ROLE=apps ;;
    *) ROLE=all ;;
  esac
fi
case "$ROLE" in
  all) PROFILES="llm,apps" ;;
  llm) PROFILES="llm" ;;
  apps) PROFILES="apps" ;;
  *) fail "--role must be all, llm or apps." ;;
esac
# Bus times (Edmonton only) is its own group. Keep it if it was on; otherwise ask once.
if [ "$ROLE" != llm ]; then
  case ",$CUR_PROFILES," in
    *,bus,*) PROFILES="$PROFILES,bus" ;;
    *) if [ ! -f .setup-asked-bus ]; then
         a=$(ask "Also run Bus times? It only works for Edmonton (ETS) stops. y/n" "n")
         case "$a" in y*|Y*) PROFILES="$PROFILES,bus" ;; esac
         touch .setup-asked-bus
       fi ;;
  esac
fi
setenv COMPOSE_PROFILES "$PROFILES" 1
note "Role: $ROLE (services: $PROFILES)"

setenv LLM_PORT 8091
if [ "$ROLE" = apps ]; then
  if [ -n "$LLM_SERVER_ARG" ]; then setenv LLM_SERVER_URL "$LLM_SERVER_ARG" 1
  elif echo "$(getenv LLM_SERVER_URL)" | grep -qE '^$|localhost|127\.0\.0\.1'; then
    url=$(ask "Address of the computer that runs the AI models (llama-swap), for example http://192.168.1.20:8091?" "")
    [ -n "$url" ] || fail "The address of the AI models computer is needed for --role apps. Run ./setup.sh again, or use --llm-server ADDRESS."
    setenv LLM_SERVER_URL "$url" 1
  fi
else
  setenv LLM_SERVER_URL "http://localhost:$(getenv LLM_PORT)" 1
fi
note "AI models server: $(getenv LLM_SERVER_URL)"

# Who may connect. Asked once; change ALLOWED_NETWORKS in .env later if needed.
if [ -z "$(getenv ALLOWED_NETWORKS)" ] && [ "$ROLE" != llm ]; then
  HOME_NET=$(ip -4 route 2>/dev/null | awk '/proto kernel/ && $1 ~ /\// && $1 !~ /^172\.(1[7-9]|2[0-9]|3[01])\./ {print $1; exit}')
  SUGGEST="127.0.0.0/8,::1/128${HOME_NET:+,$HOME_NET},100.64.0.0/10,fd7a:115c:a1e0::/48"
  note "Allowed networks: this computer, your home network${HOME_NET:+ ($HOME_NET)} and Tailscale. Separate ranges with commas."
  nets=$(ask "Which address ranges may use the tools?" "$SUGGEST")
  setenv ALLOWED_NETWORKS "$nets" 1
fi
[ "$ROLE" != llm ] && note "Allowed networks: $(getenv ALLOWED_NETWORKS)"

# Time zone, from this computer.
if [ -z "$(getenv TZ)" ]; then
  tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
  setenv TZ "${tz:-UTC}" 1
fi

# A Mac (or other computer) running Ollama, tried before the server. Optional; asked once.
if ! grep -qE '^LLM_MAC_URLS=' .env || { [ -z "$(getenv LLM_MAC_URLS)" ] && [ ! -f .setup-asked-mac ]; }; then
  if [ "$ROLE" != llm ]; then
    mac=$(ask "Address of a Mac running Ollama, for example http://192.168.1.30:11434 (several: separate with commas; leave empty for none)?" "")
    setenv LLM_MAC_URLS "$mac" 1
    touch .setup-asked-mac
  fi
fi
setenv LLM_MAC_URLS ""
if [ -n "$(getenv LLM_MAC_URLS)" ]; then
  setenv OPEN_WEBUI_OLLAMA_URLS "$(getenv LLM_MAC_URLS | tr ',' ';')"
  setenv OPEN_WEBUI_USE_MAC true
else
  setenv OPEN_WEBUI_USE_MAC false
fi
setenv OPEN_WEBUI_URL "http://localhost:8080"
setenv LLM_TTL 900
setenv WEBUI_SECRET_KEY "$(secret)"
setenv SEARXNG_SECRET "$(secret)"

# Tuning. Writing tokens is limited by memory speed, so one core is left for the other services when
# everything runs here; reading the prompt uses every core. Context: 8192 tokens is enough for a page
# with a picture; less on small computers.
if [ "$ROLE" = llm ]; then THREADS=$CPUS; else THREADS=$(( CPUS > 3 ? CPUS - 1 : CPUS )); fi
if [ "$MEM_GB" -lt 10 ]; then CTX=4096; else CTX=8192; fi
if [ "$ROLE" = llm ]; then RAM=$(( MEM_GB - 1 )); else RAM=$(( MEM_GB - 7 )); fi
[ "$RAM" -lt 3 ] && RAM=3
if [ "$MEM_GB" -le 8 ]; then JOBS=1; else JOBS=2; fi
setenv LLM_THREADS "$THREADS" "$RETUNE"
setenv LLM_THREADS_BATCH "$CPUS" "$RETUNE"
setenv LLM_CTX "$CTX" "$RETUNE"
setenv LLM_RAM_GB "$RAM" "$RETUNE"
setenv MAX_JOBS "$JOBS" "$RETUNE"
note "llama.cpp: $(getenv LLM_THREADS) threads writing, $(getenv LLM_THREADS_BATCH) reading, $(getenv LLM_CTX) tokens of context, about $(getenv LLM_RAM_GB) GB for models."
note "Mac Ollama addresses: $(getenv LLM_MAC_URLS | sed 's/^$/none/')"

# ---------------------------------------------------------------- 3. folders
say "Folders"
mkdir -p data open-webui documents llm/models searxng
$SUDO chown 1000:1000 data documents llm llm/models
[ -f llm/models.json ] && $SUDO chown 1000:1000 llm/models.json
note "data (Quick Tool Box and its speech models), open-webui (chats), documents (for ./docs.sh), llm/models (AI models)"

# ---------------------------------------------------------------- 4. models
if [ "$ROLE" != apps ]; then
  say "AI models"
  have=$(grep -c '"id"' llm/models.json 2>/dev/null || true)
  if [ "${have:-0}" = 0 ] && [ "$NO_MODELS" = 0 ]; then
    a=$(ask "Download the recommended model now (Qwen3 VL 4B: reads text and sees images, about 3.3 GB)? y/n" "y")
    case "$a" in y*|Y*) ./models.sh recommended || note "The download did not finish. Run ./models.sh recommended to try again." ;; *) ./models.sh config ;; esac
  else
    ./models.sh config
  fi
  if [ "$NO_MODELS" = 0 ] && ! grep -q '"qwen3-1.7b"' llm/models.json 2>/dev/null; then
    a=$(ask "Also download Qwen3 1.7B, a fast model for Home Assistant and quick chat (about 1.1 GB)? y/n" "y")
    case "$a" in y*|Y*) ./models.sh add qwen3-1.7b || note "The download did not finish. Run ./models.sh add qwen3-1.7b to try again." ;; esac
  fi
  # llama-swap needs its settings file, even before a model is downloaded.
  [ -f llm/llama-swap.yaml ] || ./models.sh config
fi

# ---------------------------------------------------------------- 5. start
say "Downloading and starting the containers (the first time takes a while)"
$DOCKER compose pull --ignore-buildable --quiet 2>/dev/null || $DOCKER compose pull --quiet || true
$DOCKER compose up -d --build --remove-orphans

say "Waiting for everything to answer"
wait_for() { # wait_for name url seconds
  local i
  for i in $(seq 1 "$3"); do
    if curl -fsS -o /dev/null "$2" 2>/dev/null; then note "$1: ready"; return 0; fi
    sleep 2
  done
  note "$1: not answering yet. Check with: docker compose logs $4"
}
[ "$ROLE" != apps ] && wait_for "AI models (llama-swap)" "http://localhost:$(getenv LLM_PORT)/v1/models" 60 llama-swap
if [ "$ROLE" != llm ]; then
  wait_for "Quick Tool Box" "http://localhost:3210/healthz" 60 quick-tool-box
  case ",$(getenv COMPOSE_PROFILES)," in *,bus,*) wait_for "Bus times" "http://localhost:$(getenv BUS_PORT | sed 's/^$/3220/')/healthz" 30 bus-times ;; esac
  wait_for "Open WebUI" "http://localhost:8080/health" 120 open-webui
fi

# ---------------------------------------------------------------- 6. tuning
if [ "$ROLE" != apps ] && grep -q '"id"' llm/models.json 2>/dev/null && { [ ! -f llm/.tuned ] || [ "$RETUNE" = 1 ] || [ "$(cat llm/.tuned 2>/dev/null)" != "$CPUS" ]; }; then
  say "Speed tuning"
  a=$(ask "Find the fastest settings for this processor now (about 5 minutes; do not use the AI meanwhile)? y/n" "y")
  case "$a" in
    y*|Y*) if ./models.sh tune; then echo "$CPUS" > llm/.tuned; note "Saved: $(getenv LLM_THREADS) threads writing, $(getenv LLM_THREADS_BATCH) reading."; fi ;;
    *) note "Later: ./models.sh tune" ;;
  esac
fi

# ---------------------------------------------------------------- 7. summary
IP=$( (hostname -I 2>/dev/null || true) | awk '{print $1}')
[ -n "$IP" ] || IP="THIS-COMPUTER"
say "Done"
if [ "$ROLE" != llm ]; then
  note "Quick Tool Box: http://$IP:3210  (Status page: http://$IP:3210/status)"
  case ",$(getenv COMPOSE_PROFILES)," in *,bus,*) note "Bus times:      http://$IP:$(getenv BUS_PORT | sed 's/^$/3220/')" ;; esac
  note "Open WebUI:    http://$IP:8080  (the first account you make is the administrator)"
fi
if [ "$ROLE" != apps ]; then
  note "AI models:     http://$IP:$(getenv LLM_PORT)/v1  (OpenAI-compatible, for Home Assistant and other apps)"
  note "               http://$IP:$(getenv LLM_PORT)/ui  (llama-swap's own page: models, logs, speed)"
fi
note "Over Tailscale, use this computer's Tailscale name instead of $IP."
echo
note "Next:"
[ "$ROLE" != apps ] && note "- More models: ./models.sh    Speed test: ./models.sh bench"
[ "$ROLE" != llm ] && note "- Documents for Open WebUI: put files in the documents folder, add OPEN_WEBUI_API_KEY to .env, run ./docs.sh"
[ -z "$(getenv LLM_MAC_URLS)" ] || note "- Mac: install Ollama, then let the server reach it (see README, \"The Mac\")."
