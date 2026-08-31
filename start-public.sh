#!/bin/bash
# Public mode with a supervisor: server + tunnel both auto-restart; the current public URL
# always lives in data/public-url.txt and the TV/MC links follow it automatically.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Install Node.js first (SETUP LAPTOP.command)"; exit 1; }
command -v cloudflared >/dev/null 2>&1 || { echo "Install cloudflared first: brew install cloudflared"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund || exit 1
PORT="${PORT:-$(node -e "console.log(require('./game/config.json').port||4060)")}"
SECRET="${GAME_SECRET:-$(node -e "console.log(require('./game/config.json').secret||'party60')")}"
( sleep 2.5; open "http://localhost:${PORT}/tv?k=${SECRET}" >/dev/null 2>&1 ) &
exec node scripts/supervisor.js
