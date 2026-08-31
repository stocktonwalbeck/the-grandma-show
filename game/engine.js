'use strict';
// The Grandma Show game engine. Pure state machine, no networking.
// Item types: fibbage | number | pick | image | gallery | photo | slide
// Phases: lobby, slide, read, answer, sorting, vote, reveal, scores, imageQueued,
//         galleryWait, galleryShow, galleryVote, galleryReveal, final
const crypto = require('crypto');
const { localGroups, sameText } = require('./dedupe');

const QUESTION_TYPES = new Set(['fibbage', 'number', 'pick', 'image']);
const rid = () => crypto.randomBytes(4).toString('hex');
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Mystery Guest';
const err = (error) => ({ ok: false, error });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

class Engine {
  constructor({ config, playlist, onChange, dedupe = null, generateImage = null }) {
    this.config = config;
    this.playlist = playlist;
    this.onChange = onChange || (() => {});
    this.dedupe = dedupe;               // async (prompt, truth, lies[{id,text}]) => [{ids:[], display}]  ('TRUTH' id for the truth)
    this.generateImage = generateImage; // async (prompt, meta) => { url }
    this.players = new Map();
    this.grandmaConnected = false;
    this.grandmaConnections = 0;
    this.muted = false;
    this.timer = null;
    this.deadline = null;
    this.phase = 'lobby';
    this.idx = -1;
    this.item = null;
    this.imageJobs = new Map();        // id -> {id, pid, prompt, status, url, error, roundIdx, group, shown}
    this.groups = null;                // [[pid,...], ...] locked when the game starts
    this.groupPrompts = [];            // prompt per group for the current image round
    this.lastSortInfo = null;
    this.pausedRemaining = null;       // ms left on the clock while paused
    this._clearRound();
  }

  // ---------- helpers ----------
  changed() { this.onChange(); }
  _clearRound() {
    this.round = rid();
    this.pausedRemaining = null;
    this.answers = new Map();      // playerId -> value
    this.grandmaAnswer = null;
    this.votes = new Map();        // playerId -> option key / image id
    this.options = [];             // [{key, text, authors:[], isTruth}]
    this.autoTruth = new Set();    // players whose answer matched the truth
    this.steps = [];
    this.step = -1;
    this.waitingOnGrandma = false;
    this.voteOpen = false;         // vote phase: answers shown, MC opens the clock with GO
    this.lastDeltas = {};
    this.pickOpts = [];
    this.gallery = null;           // {images:[{id,pid,prompt,url,status}], step}
  }
  _clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.deadline = null; }
  _setDeadline(sec) {
    this._clearTimer(); this.pausedRemaining = null;
    this.deadline = Date.now() + sec * 1000;
    this.timer = setTimeout(() => this._onDeadline(), sec * 1000 + 30);
  }
  extend(sec) {
    if (!this.deadline) return;
    const remaining = Math.max(0, this.deadline - Date.now());
    this._setDeadline((remaining + sec * 1000) / 1000);
    this.changed();
  }
  _currentTimer() {
    if (this.phase === 'answer') return this._timerFor(this.item);
    if (this.phase === 'vote') return this.voteOpen ? this.config.timers.vote : null;
    if (this.phase === 'galleryVote') return this.config.timers.galleryVote || 45;
    return null;
  }
  restartTimer() {
    const sec = this._currentTimer(); if (!sec) return err('No timer running in this phase');
    this.waitingOnGrandma = false; this._setDeadline(sec); this.changed(); return { ok: true };
  }
  pauseToggle() {
    if (this.pausedRemaining != null) { const sec = this.pausedRemaining / 1000; this._setDeadline(Math.max(1, sec)); this.changed(); return { ok: true, paused: false }; }
    if (!this.deadline) return err('No timer running');
    this.pausedRemaining = Math.max(1000, this.deadline - Date.now());
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.deadline = null;
    this.changed(); return { ok: true, paused: true };
  }
  removeAnswer(pid) {
    if (!['read', 'answer'].includes(this.phase)) return err('Answers can only be removed before voting');
    if (pid === 'grandma') { this.grandmaAnswer = null; this.changed(); return { ok: true }; }
    this.answers.delete(pid); this.autoTruth.delete(pid); this.changed(); return { ok: true };
  }
  _timerFor(item) {
    if (item.timer) return Number(item.timer);
    const t = this.config.timers;
    return { fibbage: t.fibbage, number: t.number, pick: t.pick, image: t.image }[item.type] || 60;
  }
  _connectedPlayers() { return [...this.players.values()].filter((p) => p.connected); }
  _voters() { return this._connectedPlayers().filter((p) => !this.autoTruth.has(p.id)); }
  _pickOptions(item) {
    if (Array.isArray(item.options) && item.options.length) return item.options.slice();
    if (Array.isArray(this.config.pickOptions) && this.config.pickOptions.length) return this.config.pickOptions.slice();
    return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((p) => p.name);
  }
  groupOf(pid) { if (!this.groups) return -1; return this.groups.findIndex((g) => g.includes(pid)); }
  _lockGroups() {
    // groups of 3-4, random: k = ceil(n/4) gives sizes of 3 or 4 for any n >= 6 (tiny rooms may dip lower)
    const pids = this._connectedPlayers().map((p) => p.id);
    for (let i = pids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pids[i], pids[j]] = [pids[j], pids[i]]; }
    const max = Number(this.config.groupMax) || 4;
    const k = Math.max(1, Math.ceil(pids.length / max));
    this.groups = Array.from({ length: k }, () => []);
    pids.forEach((pid, i) => this.groups[i % k].push(pid));
  }
  _ensureGrouped() {
    if (!this.groups) this._lockGroups();
    for (const p of this.players.values()) if (this.groupOf(p.id) < 0) { const g = this.groups.reduce((a, b) => (a.length <= b.length ? a : b)); g.push(p.id); }
  }
  _qnum(i) { let n = 0; for (let k = 0; k <= i && k < this.playlist.length; k++) if (QUESTION_TYPES.has(this.playlist[k].type)) n++; return n; }
  _qtotal() { return this.playlist.filter((q) => QUESTION_TYPES.has(q.type)).length; }
  _add(id, kind, n) {
    const p = this.players.get(id); if (!p || !n) return;
    p[kind] += n; p.score += n; this.lastDeltas[id] = (this.lastDeltas[id] || 0) + n;
  }

  // ---------- players ----------
  has(id) { return this.players.has(id); }
  _uniqueName(name, exceptId) {
    let n = cleanName(name), i = 2;
    const taken = (x) => [...this.players.values()].some((p) => p.id !== exceptId && p.name.toLowerCase() === x.toLowerCase());
    while (taken(n)) n = cleanName(name).slice(0, 12) + ' ' + i++;
    return n;
  }
  findByDevice(device) { if (!device) return null; for (const p of this.players.values()) if (p.device === device) return p.id; return null; }
  addPlayer(name, emoji, { bot = false, device = null } = {}) {
    const existing = this.findByDevice(device);
    if (existing) return existing; // one player per device, always
    const id = rid() + rid();
    this.players.set(id, { id, name: this._uniqueName(name), emoji: emoji || '🙂', score: 0, truthPts: 0, foolPts: 0, bonusPts: 0, connected: true, joinedAt: Date.now(), bot, device, history: [] });
    if (this.groups) this._ensureGrouped(); // late joiners land in the smallest group
    this.changed();
    return id;
  }
  setPhoto(id, url) { const p = this.players.get(id); if (!p) return err('Join first'); p.photo = url || null; this.changed(); return { ok: true }; }
  renamePlayer(id, name, emoji) {
    const p = this.players.get(id); if (!p) return err('Join first');
    if (name) p.name = this._uniqueName(name, id);
    if (emoji) p.emoji = emoji;
    this.changed(); return { ok: true };
  }
  _recordHistory() {
    const label = this.item ? (this.item.prompt || this.item.type) : '';
    const q = this._qnum(this.idx);
    for (const p of this.players.values()) {
      const pts = this.lastDeltas[p.id] || 0;
      p.history = (p.history || []).filter((h) => h.idx !== this.idx || h.kind !== this.item.type || h.batch !== (this.gallery ? this.gallery.b : undefined));
      if (pts) p.history.push({ idx: this.idx, q, kind: this.item.type, batch: this.gallery ? this.gallery.b : undefined, label: label.slice(0, 60), pts });
    }
  }
  // Every point on the board must be explained by truth + fool + bonus. Cheap to check, catastrophic if wrong.
  checkInvariants() {
    for (const p of this.players.values()) {
      if (p.score !== p.truthPts + p.foolPts + p.bonusPts) throw new Error(`score mismatch for ${p.name}`);
      const hist = (p.history || []).reduce((a, h) => a + h.pts, 0);
      if (hist !== p.score) throw new Error(`history mismatch for ${p.name}: ${hist} vs ${p.score}`);
    }
    return true;
  }
  setConnected(id, connected) {
    const p = this.players.get(id); if (!p) return;
    p.connected = connected;
    this.changed();
    if (!connected) { if (this.phase === 'answer') this._checkAllAnswered(); else if (this.phase === 'vote') this._checkAllVoted(); else if (this.phase === 'galleryVote') this._checkGalleryVoted(); }
  }
  removePlayer(id) {
    this.players.delete(id); this.answers.delete(id); this.votes.delete(id); this.autoTruth.delete(id);
    this.changed();
  }
  setGrandmaConnected(v) { this.grandmaConnections = typeof v === 'number' ? v : v ? 1 : 0; this.grandmaConnected = this.grandmaConnections > 0; this.changed(); }
  removeBots() { for (const p of [...this.players.values()]) if (p.bot) this.removePlayer(p.id); }

  // ---------- flow ----------
  resetGame({ keepPlayers = true } = {}) {
    this._clearTimer(); this._clearRound();
    this.imageJobs.clear();
    this.phase = 'lobby'; this.idx = -1; this.item = null; this.groups = null; this.groupPrompts = [];
    if (keepPlayers) for (const p of this.players.values()) { p.score = 0; p.truthPts = 0; p.foolPts = 0; p.bonusPts = 0; p.history = []; }
    else this.players.clear();
    this.changed();
  }
  startItem(i) {
    this._clearTimer(); this._clearRound();
    this.idx = i;
    const item = this.playlist[i];
    if (!item) { this.item = null; this.phase = 'final'; return this.changed(); }
    this.item = item;
    if (item.type === 'gallery') return this._startGallery();
    if (!QUESTION_TYPES.has(item.type)) { this.phase = 'slide'; return this.changed(); }
    if (item.type === 'pick') this.pickOpts = this._pickOptions(item);
    if (item.type === 'image') {
      this._ensureGrouped();
      const prompts = Array.isArray(item.prompts) && item.prompts.length ? item.prompts : [item.prompt];
      this.groupPrompts = this.groups.map((_, i) => prompts[i % prompts.length]);
    }
    if (this.config.manualStart === false) return this._go();
    this.phase = 'read';
    this.changed();
  }
  _openVote() {
    this.voteOpen = true;
    this._setDeadline(this.config.timers.vote);
    if (this._restorePause) { this._restorePause = false; this.pauseToggle(); }
    this.changed();
    return { ok: true };
  }
  _go() {
    if (this.phase === 'vote') return this.voteOpen ? err('Voting is already open') : this._openVote();
    if (this.phase !== 'read' && this.phase !== 'answer') return err('Nothing to start');
    if (this.phase === 'answer' && this.deadline) return err('Timer already running');
    this.phase = 'answer';
    this._setDeadline(this._timerFor(this.item));
    this.changed();
    return { ok: true };
  }
  submitAnswer(who, raw) {
    const item = this.item;
    if (this.phase === 'galleryVote') return this._submitGrandmaPick(who, raw);
    const grandmaEarly = this.phase === 'read' && who === 'grandma';
    if (this.phase !== 'answer' && !grandmaEarly) return err('Not taking answers right now');
    if (who !== 'grandma' && !this.players.has(who)) return err('Join the game first');
    let value;
    if (item.type === 'fibbage') {
      value = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, this.config.maxAnswerLength || 40);
      if (!value) return err('Type something first');
    } else if (item.type === 'number') {
      value = Number(String(raw ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(value)) return err('Enter a number');
      value = Math.round(value * 100) / 100;
    } else if (item.type === 'pick') {
      if (!this.pickOpts.includes(raw)) return err('Pick one of the options');
      value = raw;
    } else if (item.type === 'image') {
      if (who === 'grandma') return err('You are the judge on this one. Sit tight.');
      const clean = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
      const memory = clean(raw && typeof raw === 'object' ? raw.memory : '', this.config.maxMemoryLength || 100);
      const scene = clean(raw && typeof raw === 'object' ? raw.scene : raw, this.config.maxPromptLength || 240);
      if (scene.length < 3) return err('Describe what the picture should show');
      value = { memory, scene };
    } else return err('Bad item type');
    if (who === 'grandma') this.grandmaAnswer = value;
    else {
      if (item.type === 'fibbage' && this.grandmaAnswer != null && sameText(value, this.grandmaAnswer)) {
        // They wrote the truth. Credit them, but ask for a lie so they can still fool people.
        this.autoTruth.add(who);
        this.answers.delete(who);
        this.changed();
        this._checkAllAnswered();
        return { ok: true, matchedTruth: true };
      }
      this.answers.set(who, value);
    }
    this.changed();
    if (this.phase === 'answer') {
      if (this.waitingOnGrandma && this.grandmaAnswer != null) this._endAnswer();
      else this._checkAllAnswered();
    }
    return { ok: true };
  }
  _needsGrandma() { return this.item && this.item.type !== 'image'; }
  _checkAllAnswered() {
    if (this.phase !== 'answer') return;
    if (this._needsGrandma() && this.grandmaAnswer == null) return;
    for (const p of this._connectedPlayers()) if (!this.answers.has(p.id) && !this.autoTruth.has(p.id)) return;
    if (this._connectedPlayers().length === 0 && !this._needsGrandma()) return;
    this._endAnswer();
  }
  _onDeadline() {
    this.timer = null; this.deadline = null;
    if (this.phase === 'answer') {
      if (this._needsGrandma() && this.grandmaAnswer == null) { this.waitingOnGrandma = true; this.changed(); }
      else this._endAnswer();
    } else if (this.phase === 'vote') this._endVote();
    else if (this.phase === 'galleryVote') this._endGalleryVote();
  }
  _endAnswer() {
    this._clearTimer(); this.waitingOnGrandma = false;
    const t = this.item.type;
    if (t === 'fibbage') { this.phase = 'sorting'; this.changed(); this._sortAnswers(this.round); }
    else if (t === 'image') { this._startImageJobs(); this.phase = 'imageQueued'; this.changed(); }
    else { this._buildReveal(); this.phase = 'reveal'; this.step = 0; this.changed(); }
  }
  async _sortAnswers(round) {
    const truth = this.grandmaAnswer;
    const lies = [...this.answers].map(([id, text]) => ({ id, text }));
    let groups = localGroups(truth, lies);
    let source = 'local';
    if (this.dedupe && lies.length) {
      try {
        const ai = await withTimeout(this.dedupe(this.item.prompt, truth, lies), this.config.dedupeTimeoutMs || 9000);
        const repaired = this._repairGroups(ai, lies);
        if (repaired) { groups = repaired.groups; source = repaired.fixed ? 'ai (repaired: ' + repaired.fixed + ')' : 'ai'; }
        else { source = 'local (ai output unusable)'; this.lastSortRaw = ai; }
      } catch (e) { source = 'local (' + (e.message || 'ai error') + ')'; }
    }
    if (round !== this.round || this.phase !== 'sorting') return; // round moved on (skip / reset)
    this.lastSortInfo = { source, groups: groups.length, lies: lies.length };
    this._buildOptions(groups, truth);
    this.phase = 'vote';
    if (this._voters().length === 0) return this._endVote();
    if (this.config.manualVoteStart === false) this._openVote(); else { this.voteOpen = false; this._restorePause = false; }
    this.changed();
  }
  // Accept imperfect AI output: drop unknown/duplicate ids, add singletons for ids the model forgot, make sure TRUTH exists.
  _repairGroups(groups, lies) {
    if (!Array.isArray(groups) || !groups.length) return null;
    const known = new Map(lies.map((l) => [String(l.id), l.text])); known.set('TRUTH', null);
    const seen = new Set(); const out = []; const fixes = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.ids)) { fixes.push('bad group'); continue; }
      const ids = g.ids.map(String).filter((id) => { if (!known.has(id)) { fixes.push('unknown ' + id); return false; } if (seen.has(id)) { fixes.push('dup ' + id); return false; } seen.add(id); return true; });
      if (ids.length) out.push({ ids, display: typeof g.display === 'string' && g.display.trim() ? g.display.trim().slice(0, 40) : undefined });
    }
    for (const [id, text] of known) if (!seen.has(id)) { fixes.push('missing ' + id); out.push({ ids: [id], display: text || undefined }); }
    if (!out.some((g) => g.ids.includes('TRUTH'))) return null;
    return { groups: out, fixed: fixes.length ? fixes.length + ' fix' + (fixes.length > 1 ? 'es' : '') : '' };
  }
  _validGroups(groups, lies) {
    if (!Array.isArray(groups) || !groups.length) return false;
    const want = new Set(lies.map((l) => l.id)); want.add('TRUTH');
    const seen = new Set();
    for (const g of groups) {
      if (!g || !Array.isArray(g.ids) || !g.ids.length) return false;
      for (const id of g.ids) { if (!want.has(id) || seen.has(id)) return false; seen.add(id); }
    }
    return seen.size === want.size;
  }
  _buildOptions(groups, truth) {
    const opts = [];
    for (const g of groups) {
      const isTruth = g.ids.includes('TRUTH');
      const authors = g.ids.filter((id) => id !== 'TRUTH');
      if (isTruth) { for (const a of authors) { this.autoTruth.add(a); this.answers.delete(a); } opts.push({ key: rid(), text: truth, authors: [], isTruth: true }); }
      else opts.push({ key: rid(), text: g.display || this.answers.get(authors[0]) || '?', authors, isTruth: false });
    }
    this.options = shuffle(opts);
  }
  submitVote(pid, key) {
    if (this.phase === 'galleryVote') return this._submitGalleryVote(pid, key);
    if (this.phase !== 'vote') return err('Voting is closed');
    if (!this.voteOpen) return err('Read the answers on the TV. Voting opens on GO.');
    if (!this.players.has(pid)) return err('Join the game first');
    if (this.autoTruth.has(pid)) return err('You already nailed the truth');
    const o = this.options.find((x) => x.key === key);
    if (!o) return err('That answer does not exist');
    if (o.authors.includes(pid)) return err('That is your own lie, nice try');
    this.votes.set(pid, key);
    this.changed();
    this._checkAllVoted();
    return { ok: true };
  }
  _checkAllVoted() {
    if (this.phase !== 'vote' || !this.voteOpen) return;
    for (const p of this._voters()) if (!this.votes.has(p.id)) return;
    this._endVote();
  }
  _endVote() {
    this._clearTimer();
    this._buildReveal(); this.phase = 'reveal'; this.step = 0; this.changed();
  }
  _buildReveal() {
    const item = this.item, P = this.config.points, mult = item.double ? 2 : 1;
    let steps = [];
    if (item.type === 'fibbage') {
      const votersOf = (key) => [...this.votes].filter(([, k]) => k === key).map(([pid]) => pid);
      const lies = []; let truth = null;
      for (const o of this.options) { const voters = votersOf(o.key); if (o.isTruth) truth = { ...o, voters }; else lies.push({ ...o, voters }); }
      for (const l of lies) { l.points = P.fool * mult * l.voters.length; for (const a of l.authors) this._add(a, 'foolPts', l.points); }
      for (const v of truth.voters) this._add(v, 'truthPts', P.truth * mult);
      const echo = P.fool * mult * truth.voters.length; // exact-truth writers earn crowd points too
      for (const a of this.autoTruth) { this._add(a, 'truthPts', P.truth * mult); this._add(a, 'foolPts', echo); }
      const duds = lies.filter((l) => l.voters.length === 0);
      const voted = lies.filter((l) => l.voters.length >= 1).sort((a, b) => a.voters.length - b.voters.length || a.text.localeCompare(b.text));
      steps.push({ kind: 'intro', lieCount: lies.length, votedCount: voted.length, dudCount: duds.length });
      const singles = voted.filter((l) => l.voters.length === 1);
      const multi = voted.filter((l) => l.voters.length >= 2);
      if (singles.length > 1) steps.push({ kind: 'singles', lies: singles });
      else for (const l of singles) steps.push({ kind: 'lie', ...l });
      for (const l of multi) steps.push({ kind: 'lie', ...l });
      steps.push({ kind: 'truth', text: truth.text, voters: truth.voters, autoTruth: [...this.autoTruth], points: P.truth * mult, echo: P.fool * mult * truth.voters.length });
    } else if (item.type === 'number') {
      const g = this.grandmaAnswer;
      const rows = [...this.answers].map(([id, guess]) => ({ id, guess, diff: Math.abs(guess - g) })).sort((a, b) => a.diff - b.diff);
      const diffs = [...new Set(rows.map((r) => r.diff))];
      const best = diffs[0], second = diffs[1];
      for (const r of rows) {
        let pts = 0;
        if (r.diff === best) pts = P.numberClosest * mult; else if (r.diff === second) pts = P.numberSecond * mult;
        if (r.diff === 0) pts += P.numberExact * mult;
        r.points = pts; this._add(r.id, 'truthPts', pts);
      }
      steps = [{ kind: 'grandmaNumber', value: g, unit: item.unit || '' }, { kind: 'numberRanking', rows }];
    } else if (item.type === 'pick') {
      const g = this.grandmaAnswer, counts = {};
      for (const o of this.pickOpts) counts[o] = 0;
      for (const [, v] of this.answers) counts[v] = (counts[v] || 0) + 1;
      const winners = [...this.answers].filter(([, v]) => v === g).map(([id]) => id);
      for (const w of winners) this._add(w, 'truthPts', P.pick * mult);
      steps = [{ kind: 'pickSplit', options: this.pickOpts.map((o) => ({ text: o, count: counts[o] || 0 })) }, { kind: 'grandmaPick', value: g, winners, points: P.pick * mult }];
    }
    this.steps = steps;
    this._recordHistory();
  }

  // ---------- image round ----------
  _startImageJobs() {
    for (const [pid, v] of this.answers) {
      const scene = v && typeof v === 'object' ? v.scene : String(v);
      const memory = v && typeof v === 'object' ? v.memory || '' : '';
      const job = { id: rid(), pid, prompt: scene, memory, status: 'queued', url: null, error: null, roundIdx: this.idx, group: this.groupOf(pid), groupPrompt: this.groupPrompts[this.groupOf(pid)] || this.item.prompt, shown: false, startedAt: null, doneAt: null };
      this.imageJobs.set(job.id, job);
    }
    this._pumpImages();
  }
  _pumpImages() {
    const jobs = [...this.imageJobs.values()];
    const running = jobs.filter((j) => j.status === 'running').length;
    const max = this.config.imageConcurrency || 3;
    for (const job of jobs.filter((j) => j.status === 'queued').slice(0, Math.max(0, max - running))) {
      job.status = 'running'; job.startedAt = Date.now();
      const p = this.players.get(job.pid);
      const genPrompt = job.memory ? `${job.prompt}. This recreates a real memory: "${job.memory}".` : job.prompt;
      const gen = this.generateImage ? this.generateImage(genPrompt, { id: job.id, pid: job.pid, name: p ? p.name : '?' }) : Promise.reject(new Error('Image generation is not set up (no OpenAI key)'));
      Promise.resolve(gen).then((r) => { job.status = 'done'; job.url = r.url; }).catch((e) => {
        const msg = String(e && e.message || e).slice(0, 200);
        job.attempts = (job.attempts || 0) + 1;
        if (/rate limit|429/i.test(msg) && job.attempts < 4) { // rate limits melt away: back off and retry automatically
          job.status = 'waiting'; job.error = null;
          setTimeout(() => { if (job.status === 'waiting') { job.status = 'queued'; this._pumpImages(); this.changed(); } }, 12000 * job.attempts);
        } else if (/content rules/i.test(msg) && !job.softened) {
          // moderation refusal (usually prompts about other people/kids): retry once, softened to a wholesome cartoon
          job.softened = true; job.prompt = 'A wholesome, lighthearted, family-friendly cartoon-style illustration (everyone happy and safe): ' + job.prompt;
          job.status = 'queued'; job.error = null;
          setTimeout(() => this._pumpImages(), 500);
        } else { job.status = 'failed'; job.error = msg; }
      }).finally(() => { job.doneAt = Date.now(); this.changed(); this._pumpImages(); if (this.phase === 'galleryWait' && this._imagesSettled()) this._startGalleryShow(); });
    }
  }
  _pendingJobs() { return [...this.imageJobs.values()].filter((j) => !j.shown); }
  _imagesSettled() { return this._pendingJobs().every((j) => j.status === 'done' || j.status === 'failed'); } // 'waiting'/'queued'/'running' keep the gallery waiting
  retryImage(id) { const j = this.imageJobs.get(id); if (!j || j.status === 'running') return err('Nothing to retry'); j.status = 'queued'; j.error = null; this._pumpImages(); this.changed(); return { ok: true }; }
  _startGallery() {
    if (this._pendingJobs().length === 0) { this.phase = 'slide'; this.item = { type: 'slide', heading: 'No pictures this time', sub: 'Nobody wrote a prompt, or the picture round was skipped.' }; return this.changed(); }
    if (!this._imagesSettled()) { this.phase = 'galleryWait'; return this.changed(); }
    this._startGalleryShow();
  }
  _startGalleryShow() {
    const jobs = this._pendingJobs().filter((j) => j.status === 'done' || j.status === 'failed');
    const byGroup = new Map();
    for (const j of jobs) { const g = j.group < 0 ? 0 : j.group; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(j); }
    const batches = [...byGroup.entries()].sort((a, b) => a[0] - b[0]).map(([g, imgs]) => ({ group: g, prompt: imgs[0].groupPrompt, images: shuffle(imgs) }));
    this.gallery = { batches, b: 0, step: 0, grandmaPick: null };
    this.phase = 'galleryShow';
    this.changed();
  }
  _batch() { return this.gallery ? this.gallery.batches[this.gallery.b] : null; }
  _startGalleryVote() {
    this.votes = new Map(); this.gallery.grandmaPick = null;
    this.phase = 'galleryVote';
    this._setDeadline(this.config.timers.galleryVote || 45);
    this.changed();
  }
  _submitGalleryVote(pid, imageId) {
    if (!this.players.has(pid)) return err('Join the game first');
    const img = this._batch().images.find((i) => i.id === imageId);
    if (!img) return err('That picture is not in this group');
    if (img.pid === pid) return err('You cannot vote for your own picture');
    this.votes.set(pid, imageId);
    this.changed(); this._checkGalleryVoted();
    return { ok: true };
  }
  _submitGrandmaPick(who, imageId) {
    if (who !== 'grandma') return err('Use the vote buttons');
    const img = this._batch().images.find((i) => i.id === imageId);
    if (!img) return err('That picture is not in this group');
    this.gallery.grandmaPick = imageId;
    this.changed(); this._checkGalleryVoted();
    return { ok: true };
  }
  _checkGalleryVoted() {
    if (this.phase !== 'galleryVote') return;
    if (this.gallery.grandmaPick == null) return;
    const imgs = this._batch().images;
    const eligible = this._connectedPlayers().filter((p) => imgs.some((i) => i.pid !== p.id));
    for (const p of eligible) if (!this.votes.has(p.id)) return;
    this._endGalleryVote();
  }
  _endGalleryVote() {
    this._clearTimer();
    const P = this.config.points, g = this.gallery, imgs = this._batch().images;
    const counts = {}; for (const [, id] of this.votes) counts[id] = (counts[id] || 0) + 1;
    const ranking = imgs.map((i) => ({ id: i.id, pid: i.pid, votes: counts[i.id] || 0, points: (counts[i.id] || 0) * P.galleryVote })).sort((a, b) => b.votes - a.votes);
    for (const r of ranking) this._add(r.pid, 'bonusPts', r.points);
    let pick = null;
    if (g.grandmaPick) { const img = imgs.find((i) => i.id === g.grandmaPick); pick = { id: img.id, pid: img.pid, points: P.galleryGrandma }; this._add(img.pid, 'bonusPts', P.galleryGrandma); }
    const artists = imgs.map((i) => { const r = ranking.find((x) => x.id === i.id); return { id: i.id, pid: i.pid, prompt: i.prompt, votes: r ? r.votes : 0, points: (r ? r.points : 0) + (pick && pick.id === i.id ? P.galleryGrandma : 0), grandmaPick: !!(pick && pick.id === i.id) }; }).sort((a, b) => b.points - a.points);
    this.steps = [{ kind: 'crowd', ranking }, { kind: 'grandmaFavorite', pick }, { kind: 'artists', artists }];
    this.step = 0;
    this.phase = 'galleryReveal';
    this._recordHistory();
    this.changed();
  }
  _nextBatch() {
    const g = this.gallery;
    for (const im of this._batch().images) { const j = this.imageJobs.get(im.id); if (j) j.shown = true; }
    if (g.b < g.batches.length - 1) { g.b++; g.step = 0; g.grandmaPick = null; this.votes = new Map(); this.steps = []; this.step = -1; this.lastDeltas = {}; this.phase = 'galleryShow'; }
    else this.phase = 'scores';
  }

  // ---------- MC ----------
  next() {
    switch (this.phase) {
      case 'lobby': this._lockGroups(); this.startItem(0); break;
      case 'slide': case 'scores': case 'imageQueued': this.startItem(this.idx + 1); break;
      case 'read': return this._go();
      case 'answer':
        if (this._needsGrandma() && this.grandmaAnswer == null) return err(`${this.config.grandmaName} has not answered yet. Wait, or Skip this question.`);
        this._endAnswer(); break;
      case 'sorting': return err('Sorting the answers, one second');
      case 'vote': if (!this.voteOpen) return this._openVote(); this._endVote(); break;
      case 'reveal': if (this.step < this.steps.length - 1) this.step++; else this.phase = 'scores'; break;
      case 'galleryReveal': if (this.step < this.steps.length - 1) this.step++; else this._nextBatch(); break;
      case 'galleryWait': this._startGalleryShow(); break;
      case 'galleryShow': if (this.gallery.step < this._batch().images.length - 1) this.gallery.step++; else this._startGalleryVote(); break;
      case 'galleryVote': this._endGalleryVote(); break;
      case 'final': break;
    }
    this.changed();
    return { ok: true };
  }
  mc(cmd, arg) {
    switch (cmd) {
      case 'start': if (this.phase === 'lobby') { this._lockGroups(); this.startItem(0); } break;
      case 'go': return this._go();
      case 'next': return this.next();
      case 'skip': this.startItem(this.idx + 1); break;
      case 'goto': { const i = Number(arg); if (!Number.isInteger(i) || i < 0 || i >= this.playlist.length) return err('Bad index'); this.startItem(i); break; }
      case 'extend': this.extend(Number(arg) || 30); break;
      case 'reset': this.resetGame({ keepPlayers: true }); break;
      case 'newgame': this.resetGame({ keepPlayers: false }); break;
      case 'kick': this.removePlayer(String(arg)); break;
      case 'lobby': this._clearTimer(); this._clearRound(); this.phase = 'lobby'; this.groups = null; break;
      case 'mute': this.muted = !this.muted; break;
      case 'retryImage': return this.retryImage(String(arg));
      case 'restartTimer': return this.restartTimer();
      case 'pause': return this.pauseToggle();
      case 'removeAnswer': return this.removeAnswer(String(arg));
      case 'grandmaAnswer': return this.submitAnswer('grandma', arg);
      case 'replay': if (this.idx < 0) return err('Nothing to replay'); this.startItem(this.idx); break;
      case 'removeBots': this.removeBots(); break;
      case 'rename': return this.renamePlayer(arg && arg.id, arg && arg.name, arg && arg.emoji);
      default: return err('Unknown command ' + cmd);
    }
    this.changed();
    return { ok: true };
  }

  // ---------- persistence ----------
  snapshot() {
    const g = this.gallery;
    return {
      v: 1, savedAt: Date.now(),
      phase: this.phase, idx: this.idx, round: this.round, muted: this.muted,
      syntheticItem: this.item && this.idx >= 0 && this.playlist[this.idx] !== this.item ? this.item : null,
      answers: [...this.answers], grandmaAnswer: this.grandmaAnswer, votes: [...this.votes], options: this.options, autoTruth: [...this.autoTruth],
      steps: this.steps, step: this.step, waitingOnGrandma: this.waitingOnGrandma, voteOpen: this.voteOpen, lastDeltas: this.lastDeltas, pickOpts: this.pickOpts,
      remainingMs: this.pausedRemaining != null ? this.pausedRemaining : this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      gallery: g ? { b: g.b, step: g.step, grandmaPick: g.grandmaPick, batches: g.batches.map((b) => ({ group: b.group, prompt: b.prompt, imageIds: b.images.map((i) => i.id) })) } : null,
      players: [...this.players.values()],
      imageJobs: [...this.imageJobs.values()],
      groups: this.groups, groupPrompts: this.groupPrompts, lastSortInfo: this.lastSortInfo,
    };
  }
  restore(snap) {
    if (!snap || snap.v !== 1) return false;
    this._clearTimer();
    this.players = new Map(snap.players.map((p) => [p.id, { ...p, connected: false, history: p.history || [] }]));
    this.imageJobs = new Map(snap.imageJobs.map((j) => [j.id, { ...j, status: j.status === 'running' || j.status === 'waiting' ? 'queued' : j.status }]));
    this.groups = snap.groups; this.groupPrompts = snap.groupPrompts || []; this.lastSortInfo = snap.lastSortInfo || null;
    this.phase = snap.phase; this.idx = snap.idx; this.round = snap.round || rid(); this.muted = !!snap.muted;
    this.item = snap.syntheticItem || (this.idx >= 0 ? this.playlist[this.idx] || null : null);
    this.answers = new Map(snap.answers); this.grandmaAnswer = snap.grandmaAnswer; this.votes = new Map(snap.votes);
    this.options = snap.options || []; this.autoTruth = new Set(snap.autoTruth || []); this.steps = snap.steps || []; this.step = snap.step ?? -1;
    this.waitingOnGrandma = !!snap.waitingOnGrandma; this.voteOpen = !!snap.voteOpen; this.lastDeltas = snap.lastDeltas || {}; this.pickOpts = snap.pickOpts || [];
    this.gallery = snap.gallery ? { b: snap.gallery.b, step: snap.gallery.step, grandmaPick: snap.gallery.grandmaPick, batches: snap.gallery.batches.map((b) => ({ group: b.group, prompt: b.prompt, images: b.imageIds.map((id) => this.imageJobs.get(id)).filter(Boolean) })) } : null;
    this.grandmaConnected = false; this.grandmaConnections = 0;
    // timers come back PAUSED so the MC decides when the clock runs again
    this.pausedRemaining = null; this.deadline = null;
    if (this.phase === 'answer' || this.phase === 'galleryVote' || (this.phase === 'vote' && this.voteOpen)) this.pausedRemaining = Math.max(5000, snap.remainingMs || 0);
    if (this.phase === 'sorting') { this._restorePause = true; this._sortAnswers(this.round); }
    if (this.item && this.item.type === 'image' && !this.item.prompts && this.idx >= 0) this.item = this.playlist[this.idx] || this.item;
    this._pumpImages();
    this.changed();
    return true;
  }

  // ---------- views ----------
  view(role, pid) {
    const revealOK = ['reveal', 'scores', 'final', 'galleryReveal'].includes(this.phase);
    const players = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({
      id: p.id, name: p.name, emoji: p.emoji, photo: p.photo || null, score: p.score, truthPts: p.truthPts, foolPts: p.foolPts, bonusPts: p.bonusPts, connected: p.connected, bot: !!p.bot,
      answered: this.answers.has(p.id) || this.autoTruth.has(p.id), voted: this.votes.has(p.id) || (this.phase === 'vote' && this.autoTruth.has(p.id)),
    }));
    const leaderboard = players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map((p, i) => ({ ...p, rank: i + 1, delta: this.lastDeltas[p.id] || 0 }));
    const top = (k) => { const s = players.slice().sort((a, b) => b[k] - a[k]); return s.length && s[0][k] > 0 ? { id: s[0].id, name: s[0].name, emoji: s[0].emoji, value: s[0][k], tie: s.length > 1 && s[1][k] === s[0][k] } : null; };
    const it = this.item;
    const inGallery = ['galleryShow', 'galleryVote', 'galleryReveal'].includes(this.phase) && this.gallery;
    const src = role === 'mc' ? [...this.imageJobs.values()] : inGallery ? this._batch().images : ['galleryWait', 'imageQueued'].includes(this.phase) ? [...this.imageJobs.values()].filter((j) => !j.shown) : [];
    const images = src.map((j) => ({
      id: j.id, prompt: j.prompt, memory: j.memory || '', url: j.url, status: j.status, error: j.error, group: j.group, shown: j.shown,
      pid: revealOK || role === 'mc' ? j.pid : undefined, mine: role === 'player' ? j.pid === pid : undefined,
    }));
    const gal = this.gallery && inGallery ? { batch: this.gallery.b, batches: this.gallery.batches.length, group: this._batch().group, prompt: this._batch().prompt, count: this._batch().images.length } : null;
    const pending = [...this.imageJobs.values()].filter((j) => !j.shown);
    const v = {
      phase: this.phase, idx: this.idx, total: this.playlist.length, qnum: this._qnum(this.idx), qtotal: this._qtotal(),
      item: it ? { type: it.type, prompt: it.prompt, double: !!it.double, tone: it.tone || 'lie', src: it.src, caption: it.caption, heading: it.heading, sub: it.sub, unit: it.unit, image: it.image, timer: it.type ? this._timerFor(it) : null } : null,
      deadline: this.deadline, now: Date.now(), muted: this.muted, paused: this.pausedRemaining != null, pausedRemaining: this.pausedRemaining, musicMap: this.config.music || {},
      grandmaConnected: this.grandmaConnected, grandmaConnections: this.grandmaConnections, grandmaAnswered: this.grandmaAnswer != null, waitingOnGrandma: this.waitingOnGrandma, voteOpen: this.voteOpen,
      title: this.config.title, subtitle: this.config.subtitle, grandmaName: this.config.grandmaName, grandmaPhoto: this.grandmaPhotoUrl || null, maxAnswerLength: this.config.maxAnswerLength || 80,
      players, leaderboard, awards: { knows: top('truthPts'), fooler: top('foolPts') },
      answeredCount: this.answers.size + (this.item && this.item.type === 'fibbage' ? this.autoTruth.size : 0), votedCount: this.votes.size, voterCount: this._voters().length, connectedCount: this._connectedPlayers().length,
      options: this.options.map((o) => (revealOK ? { key: o.key, text: o.text, authors: o.authors, isTruth: o.isTruth } : { key: o.key, text: o.text })),
      pickOptions: this.pickOpts,
      steps: revealOK ? this.steps : [], step: this.step,
      deltas: revealOK ? this.lastDeltas : {},
      images, galleryStep: this.gallery ? this.gallery.step : -1, gallery: gal,
      groups: this.groups ? this.groups.map((g, i) => ({ i, pids: g, prompt: this.item && this.item.type === 'image' ? this.groupPrompts[i] : undefined })) : null,
      imageProgress: { total: pending.length, done: pending.filter((j) => j.status === 'done').length, failed: pending.filter((j) => j.status === 'failed').length },
    };
    if (role === 'player') {
      const me = this.players.get(pid);
      v.me = me ? {
        id: me.id, name: me.name, emoji: me.emoji, photo: me.photo || null, score: me.score, truthPts: me.truthPts, foolPts: me.foolPts,
        rank: leaderboard.find((p) => p.id === me.id)?.rank || 0,
        answer: this.answers.has(me.id) ? this.answers.get(me.id) : null,
        vote: this.votes.get(me.id) || null, autoTruth: this.autoTruth.has(me.id),
        delta: this.lastDeltas[me.id] || 0,
        group: this.groupOf(me.id), groupPrompt: this.item && this.item.type === 'image' ? this.groupPrompts[this.groupOf(me.id)] || this.item.prompt : null,
      } : null;
      v.histories = Object.fromEntries([...this.players.values()].map((p) => [p.id, p.history || []]));
      v.options = this.options.map((o) => ({ key: o.key, text: o.text, mine: o.authors.includes(pid) }));
    }
    if (role === 'grandma') { v.grandmaAnswer = this.grandmaAnswer; v.grandmaPick = this.gallery ? this.gallery.grandmaPick : null; }
    if (role === 'mc') {
      v.playlist = this.playlist.map((q, i) => ({ i, type: q.type, label: q.prompt || q.heading || q.caption || q.src || q.type, double: !!q.double, timer: QUESTION_TYPES.has(q.type) ? this._timerFor(q) : null }));
      v.grandmaAnswer = this.grandmaAnswer;
      v.liveAnswers = [...this.answers].map(([pid, value]) => ({ pid, value }));
      v.autoTruthIds = [...this.autoTruth];
      v.liveVotes = [...this.votes].map(([pid, key]) => ({ pid, key, text: this.phase === 'galleryVote' ? ((this._batch() || { images: [] }).images.find((i) => i.id === key) || {}).prompt : (this.options.find((o) => o.key === key) || {}).text }));
      v.optionsFull = this.options.map((o) => ({ key: o.key, text: o.text, authors: o.authors, isTruth: o.isTruth }));
      v.grandmaPick = this.gallery ? this.gallery.grandmaPick : null;
      v.stepCount = this.steps.length;
      v.sortInfo = this.lastSortInfo;
    }
    return v;
  }
}
module.exports = Engine;
