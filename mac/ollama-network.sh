#!/bin/bash
# Run this on the Mac (in Terminal): bash ollama-network.sh
# Makes Homebrew's Ollama start by itself at login and listen on your network, so the home server
# (Quick Tool Box and Open WebUI) can use the Mac's models. Run it again any time; it is safe.
# To undo: bash ollama-network.sh --undo
set -e
PLIST="$HOME/Library/LaunchAgents/com.local.ollama.plist"
LABEL="com.local.ollama"

if [ "${1:-}" = "--undo" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed. Ollama no longer starts by itself or listens on the network."
  exit 0
fi

OLLAMA="$(command -v ollama || true)"
[ -n "$OLLAMA" ] || { echo "Ollama is not installed. Run: brew install ollama"; exit 1; }
echo "Ollama: $OLLAMA"

# Stop other copies: Homebrew's own service and any "ollama serve" left running in a Terminal window.
brew services stop ollama >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "ollama serve" 2>/dev/null || true
sleep 1

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$OLLAMA</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key><string>0.0.0.0:11434</string>
    <key>OLLAMA_KEEP_ALIVE</key><string>15m</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ollama.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ollama.log</string>
</dict>
</plist>
PLISTEOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3

# If the macOS firewall is on, let Ollama accept connections.
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if "$FW" --getglobalstate 2>/dev/null | grep -qi enabled; then
  REAL="$(realpath "$OLLAMA" 2>/dev/null || echo "$OLLAMA")"
  echo "The macOS firewall is on. Allowing Ollama through it (your Mac password may be asked for)."
  sudo "$FW" --add "$REAL" >/dev/null && sudo "$FW" --unblockapp "$REAL" >/dev/null || echo "Could not change the firewall. Allow Ollama in System Settings, Network, Firewall, Options."
fi

echo
if lsof -nP -iTCP:11434 -sTCP:LISTEN | grep -q '\*:11434'; then
  echo "Working: Ollama is listening on the network."
else
  echo "Ollama is not listening on the network yet. Details: $HOME/Library/Logs/ollama.log"
  lsof -nP -iTCP:11434 -sTCP:LISTEN || true
  exit 1
fi
for IF in en0 en1 en2 en3 en4 en5 en6; do
  IP=$(ipconfig getifaddr $IF 2>/dev/null || true)
  [ -n "$IP" ] && echo "  $IF: http://$IP:11434"
done
echo "Test from the server with: curl http://THIS-MAC-ADDRESS:11434/api/version (the addresses are listed above)"
