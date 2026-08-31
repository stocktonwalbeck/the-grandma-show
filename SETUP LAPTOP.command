#!/bin/bash
# Double-click me ONCE on the laptop (needs internet). Installs Node.js + cloudflared + the game's dependencies.
cd "$(dirname "$0")" || exit 1
clear
echo "Setting up the laptop for The Grandma Show..."
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Installing it (this asks for your Mac password once)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || { echo "Homebrew install failed."; read -n 1 -s -r -p "Press any key to close."; exit 1; }
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
fi
command -v node >/dev/null 2>&1 || brew install node
command -v cloudflared >/dev/null 2>&1 || brew install cloudflared
npm install --no-audit --no-fund
echo
echo "Testing the public tunnel for 10 seconds..."
LOG="$(mktemp -t grandma-setup)"; cloudflared tunnel --url http://localhost:4060 --no-autoupdate > "$LOG" 2>&1 & CF=$!
for i in $(seq 1 40); do grep -q trycloudflare.com "$LOG" && break; sleep 0.5; done
if grep -q trycloudflare.com "$LOG"; then echo "Tunnel OK."; else echo "Tunnel did NOT come up (no internet?). Same-wifi mode will still work."; fi
kill $CF 2>/dev/null
echo
echo "Done. node $(node -v), cloudflared $(cloudflared --version 2>&1 | head -1)"
echo "Tonight: double-click 'START PARTY (everyone, anywhere).command'."
read -n 1 -s -r -p "Press any key to close."
