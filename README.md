# The Grandma Show 🎂

A Jackbox/Fibbage-style party game built for my mom's 60th birthday. Everyone plays on their own phone, a TV runs the show, and the guest of honor's phone is the live answer key: she types the truth, everyone else writes lies, and the crowd hunts for her real answer. The finale is an AI picture round where the family's prompts get painted with her real face, and she judges them.

Built in an afternoon with [Claude Code](https://claude.com/claude-code). Fork it, swap in your own questions, and roast your own guest of honor.

## How a round works
1. The question goes up on the TV. The MC reads it out loud and presses **GO** (music + 60s clock).
2. The guest of honor types the TRUE answer on her phone. Everyone else writes a lie that sounds like her.
3. Answers get merged (typos, duplicates, near-meanings — AI-assisted if you add a key) and go on the TV. The MC opens a 30s vote.
4. Jackbox-style reveal: each lie with a ribbon, who fell for it, points flying into the liar's face; drumroll; the truth in gold with her photo.
5. Scoring: find the truth **+1000** · each person fooled by your lie **+500** · write her EXACT answer and you get truth points **plus** +500 for every person who finds the truth (you out-impersonated everyone). Final question is double.

**Two trophies** at the end — 🧠 Knows-Them-Best (truth points) and 🎭 Best Impersonator (fooling points) — plus the overall winner and full standings.

**Picture round:** players are shuffled into groups of 3-4, each group gets a theme ("the picture that best describes: Grandma at her most chaotic"), and everyone writes a scene prompt. The AI paints each prompt with the real face from your reference photos while two more questions play. Then the gallery runs group by group: pictures shown big (artists secret), everyone votes on phones, the guest picks her favorite, and a final "who made what" screen reveals every artist, prompt, and point.

## Quick start
```bash
npm install
./start.sh              # same-wifi mode: TV opens, phones scan the QR
./start-public.sh       # public mode (brew install cloudflared): one QR works from anywhere
```
- **TV** (the screen everyone watches): `/tv?k=party60` — press `S` to show the MC + guest QR codes, space = GO/next, `M` = mute, `F` = fullscreen
- **MC console** (host's phone): `/mc?k=party60` — GO button, timers, skip/replay, a backstage view of every answer as it's typed, kick, image retry, test bots
- **Guest of honor**: `/grandma?k=party60` — locks to the first phone that opens it
- Players scan the TV QR, type a name, take a selfie (face-guide camera) — one player per phone, reconnect-proof

## Make it yours
- `game/questions.json` — the playlist and picture-round themes (blank = `____`; `"tone":"guess"` for sweet questions; `"double":true` for the finale)
- `game/config.json` — names, timers, points, room size, the `secret` in the private links (change it!)
- **AI features** (optional but the best part): put an OpenAI API key in a file named `.openai-key` in the project root, and 1-3 clear photos of your guest in `game/reference/` (see the README there). Answer-merging uses `gpt-4.1-mini` (fractions of a cent); pictures use `gpt-image-1.5` (~$0.04 each, ~90s for a 15-person round, auto-retries rate limits, auto-softens moderation refusals into cartoons). Without a key everything still works — merging falls back to smart local matching and the picture round shows text cards.
- **Sounds** are synthesized in the browser; drop mp3s into `public/music/` and `public/sfx/` to replace them (see the README there for names)

## Reliability (learned the hard way)
- Every change autosaves to `data/state.json`; a crash or restart restores mid-question with the clock paused, and phones reconnect by themselves
- `start.sh` keeps the Mac awake and restarts the server if it dies; public mode runs the tunnel under a watchdog
- Rehearse for free: `MOCK_IMAGES=1 ./start.sh`, then MC → Testing → add bots. `npm test` runs the engine suite; `FAST=1 npm run simulate` plays a whole game with bots in a minute

MIT licensed. Have a great party.
