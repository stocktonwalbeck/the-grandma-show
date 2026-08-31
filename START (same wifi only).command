#!/bin/bash
# Double-click me on the laptop. Runs the game on the local wifi only (no internet needed, no remote players).
cd "$(dirname "$0")" || exit 1
clear
echo "=============================================="
echo "   THE GRANDMA SHOW  (same-wifi mode)"
echo "=============================================="
if ! command -v node >/dev/null 2>&1; then echo "Laptop is not set up yet. Double-click 'SETUP LAPTOP.command' first."; echo; read -n 1 -s -r -p "Press any key to close."; exit 1; fi
./start.sh
echo; read -n 1 -s -r -p "Game server stopped. Press any key to close."
