// Game-show music + sound effects, synthesized with WebAudio so nothing needs downloading.
// Drop mp3s in public/music/ (answer.mp3, vote.mp3) to override the synth loops.
window.Music = (() => {
  let ctx = null, master = null, playing = null, timer = null, nextTime = 0, step = 0, tempo = 128, muted = false;
  const audioEls = {};
  const overrides = {};
  ['answer', 'vote', 'lobby', 'question'].forEach((k) => { fetch(`/music/${k}.mp3`, { method: 'HEAD' }).then((r) => { if (r.ok) overrides[k] = true; }).catch(() => {}); });
  // drop mp3s in public/sfx/ to replace any synth effect: drumroll.mp3, grandma.mp3, tick.mp3, buzzer.mp3 ...
  const sfxFiles = {};
  ['drumroll', 'grandma', 'tick', 'buzzer', 'ding', 'fanfare', 'pop', 'boing', 'slide', 'coin', 'sparkle',
   'fart', 'fart2', 'fart3', 'fart4', 'burp', 'burp2', 'burp3'].forEach((k) => { fetch(`/sfx/${k}.mp3`, { method: 'HEAD' }).then((r) => { if (r.ok) sfxFiles[k] = `/sfx/${k}.mp3`; }).catch(() => {}); });
  function playFile(name, vol = 0.8) { if (!sfxFiles[name] || muted) return false; try { const a = new Audio(sfxFiles[name]); a.volume = vol; a.play().catch(() => {}); return true; } catch { return false; } }
  function playVariant(base, vol = 0.9) { // fart -> random of fart/fart2/fart3/fart4 that actually exist
    const opts = Object.keys(sfxFiles).filter((k) => k === base || k.startsWith(base));
    if (!opts.length) return false;
    return playFile(opts[(Math.random() * opts.length) | 0], vol);
  }

  function unlock() {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
  // C major-ish bouncy progression: C, Am, F, G (semitones from C)
  const CHORDS = [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]];
  const RIFF = [0, 2, 1, 2, 3, 2, 1, 2, 0, 2, 1, 3, 2, 1, 2, 0]; // chord-tone indexes per 16th
  const BASS = [0, null, 0, null, 7, null, 0, null, 0, null, 12, null, 7, null, 0, 7];

  function osc(type, freq, t, dur, vol, filterHz) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filterHz) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterHz; o.connect(f); node = f; }
    node.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, vol, hp) {
    const len = Math.floor(ctx.sampleRate * dur); const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = hp ? 'highpass' : 'bandpass'; f.frequency.value = hp ? 6000 : 1800;
    const g = ctx.createGain(); g.gain.value = vol; s.connect(f); f.connect(g); g.connect(master); s.start(t);
  }
  function kick(t) { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.3); }

  const LOBBY_CHORDS = [[5, 9, 12, 16], [0, 4, 7, 11], [9, 12, 16, 19], [7, 11, 14, 17]]; // F, C, Am, G, gentle
  function playLobbyStep(i, t) {
    const bar = Math.floor(i / 16) % 4, s = i % 16, chord = LOBBY_CHORDS[bar];
    const spb = 60 / tempo / 4;
    if (s % 4 === 0) osc('triangle', NOTE(36 + chord[0]), t, spb * 3.5, 0.32);
    if (s % 2 === 0) { const n = 60 + chord[[0, 1, 2, 3, 2, 1, 0, 2][(s / 2) % 8]]; osc('triangle', NOTE(n), t, spb * 2.2, 0.16); }
    if (s % 8 === 4) noise(t, 0.05, 0.05, true);
    if (s === 0) for (const c of chord.slice(0, 3)) osc('sine', NOTE(48 + c), t, spb * 14, 0.06);
  }
  const Q_CHORDS = [[0, 3, 7], [0, 3, 7], [8, 12, 15], [7, 10, 14]]; // Cm, Cm, Ab, G: game-show suspense
  function playQuestionStep(i, t) {
    const bar = Math.floor(i / 16) % 4, s = i % 16, chord = Q_CHORDS[bar];
    const spb = 60 / tempo / 4;
    if (s % 4 === 0) osc('triangle', NOTE(36 + chord[0]), t, spb * 2.5, 0.3);
    if (s % 4 === 2) osc('triangle', NOTE(43 + chord[0]), t, spb * 1.2, 0.14);
    if (s % 8 === 0) for (const c of chord) osc('sawtooth', NOTE(48 + c), t, spb * 7, 0.035, 700);
    if (s === 6 || s === 14) osc('square', NOTE(72 + chord[(s / 2) % 3]), t, spb * 1.5, 0.05, 1500);
    if (s % 4 === 0) noise(t, 0.03, 0.05, true);
  }
  function playVoteStep(i, t) { // laid-back head-scratcher groove
    const bar = Math.floor(i / 16) % 4, s = i % 16, chord = CHORDS[bar];
    const spb = 60 / tempo / 4;
    if (s === 0 || s === 10) kick(t);
    if (s === 4 || s === 12) noise(t, 0.09, 0.2, false);
    if (s % 4 === 2) noise(t, 0.04, 0.08, true);
    const bl = [0, null, null, 7, null, null, 0, null, 3, null, null, 7, null, 5, null, null][s];
    if (bl != null) osc('triangle', NOTE(36 + bl + chord[0]), t, spb * 2.6, 0.45);
    if (s === 6 || s === 14) osc('square', NOTE(64 + chord[(s / 2) % 3]), t, spb * 2, 0.07, 1400);
    if (s === 0) for (const c of chord.slice(0, 3)) osc('sawtooth', NOTE(48 + c), t, spb * 10, 0.04, 800);
  }
  function playStep(i, t) {
    if (playing === 'lobby') return playLobbyStep(i, t);
    if (playing === 'question') return playQuestionStep(i, t);
    if (playing === 'vote') return playVoteStep(i, t);
    const bar = Math.floor(i / 16) % 4, s = i % 16, chord = CHORDS[bar];
    const spb = 60 / tempo / 4;
    if (s % 8 === 0) kick(t);
    if (s % 8 === 4) noise(t, 0.12, 0.35, false);
    if (s % 2 === 1) noise(t, 0.04, 0.12, true);
    const b = BASS[s]; if (b != null) osc('triangle', NOTE(36 + b + chord[0]), t, spb * 1.8, 0.5);
    if (s % 2 === 0) { const n = 60 + chord[RIFF[s] % chord.length] + (Math.floor(i / 64) % 2 ? 12 : 0); osc('square', NOTE(n), t, spb * 1.5, 0.11, 2200); }
    if (s === 0 || s === 8) for (const c of chord.slice(0, 3)) osc('sawtooth', NOTE(48 + c), t, spb * 6, 0.05, 900);
  }
  function scheduler() {
    while (nextTime < ctx.currentTime + 0.2) { playStep(step, nextTime); nextTime += 60 / tempo / 4; step++; }
    timer = setTimeout(scheduler, 60);
  }
  function stopSynth() { clearTimeout(timer); timer = null; }
  function stopAudioEls() { for (const k in audioEls) { try { audioEls[k].pause(); audioEls[k].currentTime = 0; } catch {} } }

  function start(kind) {
    if (playing === kind) return;
    stop();
    playing = kind;
    if (muted) return;
    if (overrides[kind]) { const el = audioEls[kind] || (audioEls[kind] = Object.assign(new Audio(`/music/${kind}.mp3`), { loop: true, volume: 0.6 })); el.play().catch(() => {}); return; }
    if (!ctx) return;
    tempo = kind === 'vote' ? 104 : kind === 'lobby' ? 96 : kind === 'question' ? 92 : 126; step = 0; nextTime = ctx.currentTime + 0.05; scheduler();
  }
  function stop() { playing = null; stopSynth(); stopAudioEls(); }
  function setMuted(m) { if (m === muted) return; muted = m; if (m) { stopSynth(); stopAudioEls(); } else if (playing) { const k = playing; playing = null; start(k); } }

  function snareHit(t, vol) {
    const len = Math.floor(ctx.sampleRate * 0.06); const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(bp); bp.connect(g); g.connect(master); src.start(t);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.04);
    const og = ctx.createGain(); og.gain.setValueAtTime(vol * 0.5, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.06);
  }
  const sfx = {
    tick() { if (playFile('tick', 0.9)) return; if (!ctx || muted) return; const t = ctx.currentTime; osc('square', 1400, t, 0.07, 0.45); osc('square', 2800, t, 0.05, 0.2); },
    buzzer() { if (playFile('buzzer')) return; if (!ctx || muted) return; const t = ctx.currentTime; osc('sawtooth', 160, t, 0.5, 0.35, 700); osc('sawtooth', 110, t + 0.02, 0.5, 0.35, 700); },
    ding() { if (playFile('ding')) return; if (!ctx || muted) return; const t = ctx.currentTime; osc('sine', 1046, t, 0.7, 0.3); osc('sine', 1568, t + 0.08, 0.9, 0.2); },
    whoosh() { if (!ctx || muted) return; noise(ctx.currentTime, 0.35, 0.3, true); },
    fanfare() { if (playFile('fanfare')) return; if (!ctx || muted) return; const t = ctx.currentTime; [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => osc('square', NOTE(60 + n), t + i * 0.11, 0.5, 0.15, 3000)); [0, 7, 12].forEach((n) => osc('triangle', NOTE(48 + n), t + 0.8, 1.6, 0.25)); },
    // press roll: accelerating snare hits with a crescendo. Drop public/sfx/drumroll.mp3 to use a sampled one.
    drumroll(sec = 2) {
      if (sfxFiles.drumroll && !muted) { try { const a = new Audio(sfxFiles.drumroll); a.volume = 0.9; a.play().catch(() => {}); setTimeout(() => { try { a.pause(); } catch {} }, sec * 1000 + 400); return; } catch {} }
      if (!ctx || muted) return;
      const t0 = ctx.currentTime; let t = 0;
      while (t < sec) { const prog = t / sec; snareHit(t0 + t, 0.10 + prog * 0.5); t += 0.085 - 0.045 * prog; }
      snareHit(t0 + sec, 0.9);
    },
    grandma() { // her lock-in: harp run up + sparkle. Unmistakable.
      if (playFile('grandma')) return;
      if (!ctx || muted) return;
      const t = ctx.currentTime;
      [60, 64, 67, 72, 76, 79, 84].forEach((n, i) => osc('sine', NOTE(n), t + i * 0.07, 0.6, 0.28));
      osc('sine', NOTE(88), t + 0.52, 1.1, 0.22);
      noise(t + 0.5, 0.25, 0.06, true);
    },
    pop() { if (playFile('pop')) return; if (!ctx || muted) return; const t = ctx.currentTime; const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'sine'; const f = 300 + Math.random() * 500; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.09); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.16); },
    boing() { if (playFile('boing')) return; if (!ctx || muted) return; const t = ctx.currentTime; const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(700, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.25); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.32); },
    coin() { if (playFile('coin', 0.5)) return; if (!ctx || muted) return; const t = ctx.currentTime; osc('square', 988, t, 0.09, 0.2); osc('square', 1319, t + 0.09, 0.25, 0.2); },
    fart() {
      if (playVariant('fart')) return;
      if (!ctx || muted) return;
      const t = ctx.currentTime, dur = 0.4 + Math.random() * 0.3;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(95 + Math.random() * 35, t); o.frequency.exponentialRampToValueAtTime(42, t + dur);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 24 + Math.random() * 14;
      const lg = ctx.createGain(); lg.gain.value = 35; lfo.connect(lg); lg.connect(o.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    },
    burp() {
      if (playVariant('burp')) return;
      if (!ctx || muted) return;
      const t = ctx.currentTime, dur = 0.35;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(70, t + dur);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 9; const lg = ctx.createGain(); lg.gain.value = 18; lfo.connect(lg); lg.connect(o.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 550; f.Q.value = 4;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    },
    slide() { if (playFile('slide')) return; if (!ctx || muted) return; const t = ctx.currentTime; const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(350, t); o.frequency.exponentialRampToValueAtTime(1100, t + 0.35); const g = ctx.createGain(); g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.5); },
    sparkle() { if (playFile('sparkle', 0.5)) return; if (!ctx || muted) return; const t = ctx.currentTime; [72, 76, 79, 84].forEach((n, i) => osc('sine', NOTE(n), t + i * 0.06, 0.5, 0.12)); noise(t + 0.05, 0.2, 0.04, true); },
    submit() { const r = Math.random(); if (r < 0.28) sfx.pop(); else if (r < 0.5) sfx.fart(); else if (r < 0.68) sfx.burp(); else if (r < 0.85) sfx.boing(); else sfx.slide(); },
  };
  return { unlock, start, stop, setMuted, sfx, get playing() { return playing; }, get ready() { return !!ctx; } };
})();
