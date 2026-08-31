'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Engine = require('./game/engine');
const ai = require('./game/ai');
const { attachBots } = require('./game/bots');

const ROOT = __dirname;
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const config = readJSON('game/config.json');
const questions = readJSON('game/questions.json');

const PORT = Number(process.env.PORT || config.port || 4060);
const SECRET = process.env.GAME_SECRET || config.secret || 'party60';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const IMG_DIR = path.join(ROOT, 'data', 'images');
const PHOTO_DIR = path.join(ROOT, 'data', 'photos');
fs.mkdirSync(IMG_DIR, { recursive: true }); fs.mkdirSync(PHOTO_DIR, { recursive: true });
// Grandma's face for the truth reveal, from the reference photos
let grandmaPhotoUrl = null;
if (config.grandmaPhoto && fs.existsSync(path.join(ROOT, config.grandmaPhoto))) {
  fs.copyFileSync(path.join(ROOT, config.grandmaPhoto), path.join(PHOTO_DIR, 'grandma.jpg'));
  grandmaPhotoUrl = '/photos/grandma.jpg?v=' + fs.statSync(path.join(PHOTO_DIR, 'grandma.jpg')).mtimeMs.toFixed(0);
}
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'data', 'state.json');
const FRESH = process.argv.includes('--fresh') || !!process.env.FRESH;

// ---- AI wiring (optional). Key comes ONLY from ./.openai-key or GRANDMA_OPENAI_KEY, never a shared env var.
const oa = config.openai || {};
const apiKey = ai.loadKey(ROOT, oa.keyFile);
const MOCK = !!process.env.MOCK_IMAGES;
const dedupeModel = oa.dedupeModel || 'gpt-4.1-mini';
const dedupe = apiKey && oa.dedupe !== false ? (prompt, truth, lies) => ai.dedupeAnswers({ apiKey, model: dedupeModel }, { prompt, truth, lies }) : null;
const refPaths = (oa.referencePhotos || (oa.referencePhoto ? [oa.referencePhoto] : [])).map((r) => path.join(ROOT, r));
const imageOpts = { apiKey, model: oa.imageModel || 'gpt-image-1-mini', quality: oa.imageQuality || 'medium', size: oa.imageSize || '1024x1024', refPaths, inputFidelity: oa.inputFidelity || undefined, promptPrefix: oa.imagePromptPrefix || '', outDir: IMG_DIR };
const refCount = ai.refFiles(imageOpts).length;
let useMockImages = MOCK; // MC can flip this live from the Testing panel
const realGen = apiKey && oa.images !== false ? (p, m) => ai.generateImage(imageOpts, p, m) : null;
const generateImage = (p, m) => (useMockImages || !realGen ? ai.mockImage(imageOpts, p, m) : realGen(p, m));

function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  const rank = (x) => (x.name === 'en0' ? 4 : 0) + (x.address.startsWith('192.168.') ? 2 : x.address.startsWith('10.') ? 1 : 0) - (x.name.startsWith('bridge') || x.name.startsWith('utun') ? 10 : 0);
  return out.sort((a, b) => rank(b) - rank(a));
}
// The supervisor writes the current tunnel URL here and rewrites it if the tunnel is ever replaced.
const URL_FILE = path.join(ROOT, 'data', 'public-url.txt');
let urlCache = { at: 0, val: null };
function baseUrl() {
  const now = Date.now();
  if (now - urlCache.at > 3000) {
    urlCache.at = now;
    try { urlCache.val = fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, 'utf8').trim() : null; } catch { urlCache.val = null; }
  }
  if (urlCache.val) return urlCache.val;
  if (PUBLIC_URL) return PUBLIC_URL;
  const ip = lanIPs()[0];
  return `http://${ip ? ip.address : 'localhost'}:${PORT}`;
}

const sockets = new Set();
let grandmaDevice = null;
const socketsFor = (pid) => [...sockets].filter((w) => w.role === 'player' && w.pid === pid);
const grandmaSockets = () => [...sockets].filter((w) => w.role === 'grandma');
let engine = null;
function sendView(ws) {
  if (!engine || ws.readyState !== 1 || !ws.role) return;
  ws.send(JSON.stringify({ t: 'state', ...engine.view(ws.role, ws.pid) }));
}
let pending = null;
function broadcast() {
  if (pending) return;
  pending = setImmediate(() => { pending = null; for (const ws of sockets) sendView(ws); });
}
engine = new Engine({ config, playlist: questions.playlist, onChange: () => { broadcast(); scheduleSave(); }, dedupe, generateImage });
engine.grandmaPhotoUrl = grandmaPhotoUrl;
// ---- crash safety: every change is written to data/state.json (atomic), restored on the next start
let saveTimer = null, lastSavedAt = 0, lastSavedKey = '';
const phaseKey = () => `${engine.phase}|${engine.idx}|${engine.step}|${engine.gallery ? engine.gallery.b + ':' + engine.gallery.step : ''}`;
function scheduleSave() {
  if (phaseKey() !== lastSavedKey) { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } return saveNow(); } // phase changes hit disk immediately
  if (saveTimer) return; saveTimer = setTimeout(saveNow, 120);
}
function saveNow() {
  saveTimer = null; lastSavedKey = phaseKey();
  try { const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(engine.snapshot())); fs.renameSync(tmp, STATE_FILE); lastSavedAt = Date.now(); }
  catch (e) { console.error('  ! could not save state:', e.message); }
}
let restored = null;
if (!FRESH && fs.existsSync(STATE_FILE)) {
  try { const snap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (engine.restore(snap)) restored = { phase: engine.phase, players: engine.players.size, age: Math.round((Date.now() - snap.savedAt) / 1000) }; }
  catch (e) { console.error('  ! saved state unreadable, starting fresh:', e.message); }
}
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
const bots = attachBots(engine, { fast: !!process.env.FAST_BOTS });

const app = express();
const page = (f) => (req, res) => res.sendFile(path.join(ROOT, 'public', f));
app.get('/', page('play.html'));
app.get('/tv', page('tv.html'));
app.get('/grandma', page('grandma.html'));
app.get('/mc', page('mc.html'));
app.use('/images', express.static(IMG_DIR, { maxAge: '1h' }));
app.use('/photos', express.static(PHOTO_DIR, { maxAge: '1d' }));
app.use(express.json({ limit: '600kb' }));
// selfie upload: JSON {id, device, data: "data:image/jpeg;base64,..."} -> data/photos/<id>.jpg
app.post('/api/photo', (req, res) => {
  const { id, device, data } = req.body || {};
  if (!id || !engine.has(id)) return res.status(400).json({ error: 'unknown player' });
  const p = engine.players.get(id);
  if (p.device && device && p.device !== device) return res.status(403).json({ error: 'not your player' });
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) return res.status(400).json({ error: 'bad image' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400 * 1024) return res.status(413).json({ error: 'too big' });
  fs.writeFileSync(path.join(PHOTO_DIR, id + '.jpg'), buf);
  const url = `/photos/${id}.jpg?v=${Date.now()}`;
  engine.setPhoto(id, url);
  res.json({ ok: true, url });
});
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/info', async (req, res) => {
  const joinUrl = baseUrl();
  res.json({ joinUrl, qr: await QRCode.toDataURL(joinUrl, { margin: 1, width: 640 }), publicMode: !!PUBLIC_URL });
});
app.get('/api/admin', async (req, res) => {
  if (req.query.k !== SECRET) return res.status(403).json({ error: 'Wrong secret' });
  const b = baseUrl();
  const grandmaUrl = `${b}/grandma?k=${SECRET}`, mcUrl = `${b}/mc?k=${SECRET}`, tvUrl = `${b}/tv?k=${SECRET}`, remoteTvUrl = `${b}/tv`;
  res.json({
    joinUrl: b, grandmaUrl, mcUrl, tvUrl, remoteTvUrl, ips: lanIPs(), publicMode: !!PUBLIC_URL,
    savedAgo: lastSavedAt ? Math.round((Date.now() - lastSavedAt) / 1000) : null, restored, grandmaBound: !!grandmaDevice, mockImages: useMockImages,
    ai: { dedupe: dedupe ? dedupeModel : null, images: MOCK ? 'mock' : generateImage ? `${imageOpts.model} / ${imageOpts.quality}` : null, refPhoto: refCount, costPerImage: ai.estimateImageCost(imageOpts.model, imageOpts.quality) },
    grandmaQr: await QRCode.toDataURL(grandmaUrl, { margin: 1, width: 400 }),
    mcQr: await QRCode.toDataURL(mcUrl, { margin: 1, width: 400 }),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  sockets.add(ws); ws.role = null; ws.pid = null; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const reply = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    if (m.t === 'hello') {
      if (m.role === 'player') {
        ws.role = 'player';
        const byDevice = engine.findByDevice(m.device);
        if (m.id && engine.has(m.id)) { ws.pid = m.id; engine.setConnected(m.id, true); }
        else if (byDevice) { ws.pid = byDevice; engine.setConnected(byDevice, true); reply({ t: 'joined', id: ws.pid }); }
        else if (m.name) {
          if (engine.players.size >= (config.maxPlayers || 16)) return reply({ t: 'error', error: `The room is full (${config.maxPlayers || 16} players). Share a phone with someone who is in.` });
          ws.pid = engine.addPlayer(m.name, m.emoji, { device: m.device || null }); reply({ t: 'joined', id: ws.pid });
        }
        else ws.pid = null;
      } else if (m.role === 'grandma' || m.role === 'mc') {
        if (m.secret !== SECRET) return reply({ t: 'error', error: 'Wrong secret. Open this page from the link on the MC screen.' });
        if (m.role === 'grandma') {
          // Grandma's code binds to the first phone that uses it. Every other phone is refused.
          if (grandmaDevice && m.device && m.device !== grandmaDevice) return reply({ t: 'error', error: "This is Grandma's phone only, and hers is already connected. If her phone died, the MC can allow a new one." });
          if (m.device && !grandmaDevice) grandmaDevice = m.device;
        }
        ws.role = m.role;
        if (m.role === 'grandma') engine.setGrandmaConnected(grandmaSockets().length);
      } else if (m.role === 'tv') { ws.role = 'tv'; ws.isMc = m.secret === SECRET; }
      else return;
      sendView(ws); broadcast(); return;
    }
    if (m.t === 'answer') {
      const who = ws.role === 'grandma' ? 'grandma' : ws.role === 'player' ? ws.pid : null;
      if (!who) return reply({ t: 'ack', ok: false, error: 'Join first' });
      return reply({ t: 'ack', kind: 'answer', ...engine.submitAnswer(who, m.value) });
    }
    if (m.t === 'rename') {
      if (ws.role !== 'player' || !ws.pid) return reply({ t: 'ack', ok: false, error: 'Join first' });
      return reply({ t: 'ack', kind: 'rename', ...engine.renamePlayer(ws.pid, m.name, m.emoji) });
    }
    if (m.t === 'vote') {
      if (ws.role !== 'player' || !ws.pid) return reply({ t: 'ack', ok: false, error: 'Join first' });
      return reply({ t: 'ack', kind: 'vote', ...engine.submitVote(ws.pid, m.key) });
    }
    if (m.t === 'mc') {
      if (ws.role !== 'mc' && !(ws.role === 'tv' && ws.isMc)) return reply({ t: 'ack', ok: false, error: 'Not the MC' });
      if (m.cmd === 'addBots') { bots.add(Math.min(30, Number(m.arg) || 4)); return reply({ t: 'ack', cmd: m.cmd, ok: true }); }
      if (m.cmd === 'newGrandmaPhone') { grandmaDevice = null; for (const g of grandmaSockets()) { try { g.send(JSON.stringify({ t: 'error', error: 'The MC is switching Grandma to a new phone. Scan the gold code again on the phone she is using now.' })); g.close(); } catch {} } return reply({ t: 'ack', cmd: m.cmd, ok: true }); }
      if (m.cmd === 'mockImages') { useMockImages = !useMockImages; return reply({ t: 'ack', cmd: m.cmd, ok: true }); }
      if (m.cmd === 'mockStatus') { return reply({ t: 'ack', cmd: m.cmd, ok: true, mock: useMockImages, hasKey: !!realGen }); }
      if (m.cmd === 'resetRoom') { engine.mc('newgame'); for (const w of sockets) if (w.role === 'player') { w.pid = null; } saveNow(); return reply({ t: 'ack', cmd: m.cmd, ok: true }); }
      return reply({ t: 'ack', cmd: m.cmd, ...engine.mc(m.cmd, m.arg) });
    }
  });
  ws.on('close', () => {
    sockets.delete(ws);
    if (ws.role === 'player' && ws.pid && socketsFor(ws.pid).length === 0) engine.setConnected(ws.pid, false);
    if (ws.role === 'grandma') engine.setGrandmaConnected(grandmaSockets().length);
  });
});
setInterval(() => {
  for (const ws of sockets) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch {} }
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  const b = baseUrl();
  const cost = ai.estimateImageCost(imageOpts.model, imageOpts.quality);
  console.log('');
  console.log('  THE GRANDMA SHOW is running');
  console.log('  ------------------------------------------------');
  console.log(`  TV (open on the laptop):   http://localhost:${PORT}/tv?k=${SECRET}`);
  console.log(`  Players scan / type:       ${b}`);
  console.log(`  Grandma's phone:           ${b}/grandma?k=${SECRET}`);
  console.log(`  MC (your phone):           ${b}/mc?k=${SECRET}`);
  console.log(`  Remote family TV view:     ${b}/tv`);
  console.log('  ------------------------------------------------');
  console.log(restored ? `  RESTORED the saved game from ${restored.age}s ago: phase "${restored.phase}", ${restored.players} players. Phones reconnect by themselves. (Start with --fresh to wipe it.)` : '  Fresh game. Every change autosaves to data/state.json; a restart picks up where it left off.');
  console.log(`  Answer sorting:  ${dedupe ? 'AI (' + dedupeModel + ') with local fallback' : 'local matching only (no OpenAI key)'}`);
  console.log(`  Image round:     ${MOCK ? 'MOCK images, costs nothing' : generateImage ? `${imageOpts.model} ${imageOpts.quality}, ~$${cost} per image, reference photos: ${refCount}` : 'OFF (no OpenAI key). Prompts will show as text cards.'}`);
  const ips = lanIPs();
  if (ips.length > 1) console.log('  Other IPs on this machine: ' + ips.map((i) => `${i.name}=${i.address}`).join(', '));
  if (PUBLIC_URL) console.log(`  PUBLIC mode: QR points at ${PUBLIC_URL} (works from anywhere, including out of state)`);
  console.log('');
});
