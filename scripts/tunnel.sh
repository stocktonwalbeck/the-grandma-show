#!/bin/bash
# Cloudflared quick tunnel: holds ONE url for the life of the process and survives network blips
# internally (it keeps 4 redundant edge connections). Restarted only if the process itself dies.
GAME="$HOME/Desktop/grandma-60-game"
GID=$(cat "$GAME/data/gist-id.txt" 2>/dev/null)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
while true; do
  cloudflared tunnel --url http://localhost:4060 --no-autoupdate 2>&1 | while read -r line; do
    echo "$line"
    u=$(echo "$line" | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | head -1)
    if [ -n "$u" ] && [ "$u" != "$(cat "$GAME/data/public-url.txt" 2>/dev/null)" ]; then
      echo "$u" > "$GAME/data/public-url.txt"
      echo "TUNNEL URL: $u"
      if [ -n "$GID" ]; then gh api "gists/$GID" -X PATCH -f "files[grandma-game-link.txt][content]=$u" >/dev/null 2>&1 && echo "bookmark updated"; fi
    fi
  done
  echo "cloudflared died, restarting in 3s"; sleep 3
done
