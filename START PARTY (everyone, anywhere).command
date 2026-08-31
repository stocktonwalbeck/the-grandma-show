#!/bin/bash
# Double-click me on the laptop. Runs the game with a PUBLIC link so people in the room AND out of state can scan the same QR.
cd "$(dirname "$0")" || exit 1
clear
echo "=============================================="
echo "   THE GRANDMA SHOW  (public mode)"
echo "=============================================="
if ! command -v node >/dev/null 2>&1 || ! command -v cloudflared >/dev/null 2>&1; then
  echo "Laptop is not set up yet. Double-click 'SETUP LAPTOP.command' first."; echo; read -n 1 -s -r -p "Press any key to close."; exit 1
fi
./start-public.sh
echo; read -n 1 -s -r -p "Game server stopped. Press any key to close."
