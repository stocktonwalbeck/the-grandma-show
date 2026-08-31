#!/bin/bash
# One-command start for The Grandma Show. Keeps the Mac awake, restarts the server if it ever dies,
# and the server itself restores the saved game on restart. Ctrl+C to stop.  ./start.sh --fresh wipes the saved game.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed on this machine. Double-click 'SETUP LAPTOP.command' (needs internet) or install from https://nodejs.org"; exit 1
fi
if [ ! -d node_modules ]; then echo "First run: installing dependencies..."; npm install --no-audit --no-fund || exit 1; fi
PORT="${PORT:-$(node -e "console.log(require('./game/config.json').port||4060)")}"
SECRET="${GAME_SECRET:-$(node -e "console.log(require('./game/config.json').secret||'party60')")}"
( sleep 1.5; open "http://localhost:${PORT}/tv?k=${SECRET}" >/dev/null 2>&1 ) &
KEEPAWAKE=""; command -v caffeinate >/dev/null 2>&1 && KEEPAWAKE="caffeinate -dims"
ARGS=("$@")
while true; do
  $KEEPAWAKE node server.js "${ARGS[@]}"
  CODE=$?
  [ $CODE -eq 0 ] && break
  echo; echo "  Server stopped (exit $CODE). Restarting in 2 seconds with the saved game... (Ctrl+C to quit)"; sleep 2
  ARGS=()
done
