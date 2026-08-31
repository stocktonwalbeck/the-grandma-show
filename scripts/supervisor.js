'use strict';
// Keeps the whole show alive: the game server, the public tunnel, and the Mac itself.
// - node server.js: restarted within 2s if it dies (it restores the saved game).
// - cloudflared tunnel: restarted within 2s if it dies; the fresh URL is written to
//   data/public-url.txt, which the server reads live, so the TV QR and MC links update themselves.
// - caffeinate keeps the Mac awake while this runs.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || require(path.join(ROOT, 'game', 'config.json')).port || 4060);
const URL_FILE = path.join(ROOT, 'data', 'public-url.txt');
fs.mkdirSync(path.dirname(URL_FILE), { recursive: true });
const log = (m) => console.log(`[supervisor ${new Date().toISOString().slice(11, 19)}] ${m}`);

let stopping = false;
process.on('SIGINT', () => { stopping = true; log('stopping'); process.exit(0); });
process.on('SIGTERM', () => { stopping = true; process.exit(0); });

// keep the Mac awake
try { spawn('caffeinate', ['-dims'], { stdio: 'ignore' }).unref(); } catch {}

function runServer() {
  if (stopping) return;
  const p = spawn('node', ['server.js'], { cwd: ROOT, stdio: 'inherit' });
  p.on('exit', (code) => { if (stopping) return; log(`server exited (${code}), restarting in 2s (saved game restores)`); setTimeout(runServer, 2000); });
}
function runTunnel() {
  if (stopping) return;
  if (fs.existsSync(path.join(ROOT, 'data', 'url-lock'))) { log('url-lock present: an external tunnel owns the URL, not starting cloudflared'); return; }
  const p = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { cwd: ROOT });
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && fsReadSafe() !== m[0]) { fs.writeFileSync(URL_FILE, m[0]); log(`tunnel URL: ${m[0]} (TV QR + links update automatically)`); }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('exit', (code) => { if (stopping) return; log(`tunnel exited (${code}), restarting in 2s`); buf = ''; setTimeout(runTunnel, 2000); });
}
const fsReadSafe = () => { try { return fs.readFileSync(URL_FILE, 'utf8').trim(); } catch { return ''; } };
log(`starting on port ${PORT}`);
runServer();
setTimeout(runTunnel, 1500);
setInterval(() => {}, 60000); // hold the loop
