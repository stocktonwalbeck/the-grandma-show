'use strict';
// Park the running server in a specific phase for screenshots / manual QA, then hold.
// Usage: node scripts/stage.js <itemIdx> <target> [holdSeconds]
//   target: lobby | read | answer (partial) | vote (partial) | intro | singles | lie | truth | scores
//           | grandmaNumber | numberRanking | pickSplit | grandmaPick
//           | imageQueued | galleryShow | galleryVote (partial) | crowd | grandmaFavorite | final
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:4060';
const SECRET = process.env.SECRET || 'party60';
const ITEM = Number(process.argv[2] || 0), TARGET = process.argv[3] || 'lobby', HOLD = Number(process.argv[4] || 8);
const BOTS = [['Uncle Dave', '🦊'], ['Aunt Lisa', '🦄'], ['Cousin Max', '🦖'], ['Tiny Tim', '🐸'], ['Aunt Meg', '🦩'], ['Big Steve', '🦁']];
const LIES = ['Stealing a goose', 'Tax fraud', 'Yelling at a ref', 'Too many cats', 'Punching a mime', 'stealing a gooose'];
const TRUTH = 'Jaywalking, honestly';
const NUMS = [3, 7, 0, 12, 5, 2], GNUM = 4;
const PROMPTS = ['Grandma dancing on a table at Arctic Circle in a silky purple tracksuit', 'Grandma asleep in a pitch-black closet on a pile of polyester', 'Grandma returning a mountain of gifts to the store with a smile', 'Grandma sunbathing while getting a scalp massage', 'Grandma with her bra over her shirt, stranger asking "did you lose a bet?"', 'this one will fail'];
const GALLERY_TARGETS = new Set(['galleryShow', 'galleryVote', 'crowd', 'grandmaFavorite', 'artists']);
const everyone = TARGET !== 'answer';
function client(role, onState, extra = {}, onAck) {
  const ws = new WebSocket(URL);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('open', () => send({ t: 'hello', role, secret: SECRET, ...extra }));
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'state') onState(m, send); if (m.t === 'error') { console.error(m.error); process.exit(1); } if (m.t === 'ack' && onAck) onAck(m, send); });
  ws.on('error', (e) => { console.error(e.message); process.exit(1); });
  return send;
}
function bot(i) {
  let did = null;
  client('player', (s, send) => {
    const me = s.me; if (!me) return;
    const key = s.phase + s.idx + (s.gallery ? '|' + s.gallery.batch : '') + (s.voteOpen ? '|open' : '');
    if (s.phase === 'answer' && me.answer == null && did !== key && (everyone || i < 3)) {
      did = key;
      const it = s.item;
      const v = it.type === 'fibbage' ? LIES[i] : it.type === 'number' ? NUMS[i] : it.type === 'image' ? { memory: 'That one Thanksgiving', scene: PROMPTS[i] } : s.pickOptions[i % s.pickOptions.length];
      setTimeout(() => send({ t: 'answer', value: v }), 100 + i * 60);
    }
    if (s.phase === 'vote' && s.voteOpen && !me.vote && !me.autoTruth && did !== key && (TARGET !== 'vote' || i < 2)) {
      did = key;
      const byText = (t) => s.options.find((o) => o.text.toLowerCase().includes(t) && !o.mine);
      const truth = s.options.find((o) => o.text === TRUTH);
      const others = s.options.filter((o) => !o.mine && o.text !== TRUTH);
      const opt = (TARGET === 'singles' ? others[i % others.length] : (i === 1 || i === 5 ? truth : i === 0 ? byText('tax') : byText('goose'))) || s.options.find((o) => !o.mine);
      setTimeout(() => send({ t: 'vote', key: opt.key }), 100 + i * 60);
    }
    if (s.phase === 'galleryVote' && !me.vote && did !== key && (TARGET !== 'galleryVote' || i < 2)) {
      did = key;
      const opts = s.images.filter((im) => !im.mine && im.status === 'done');
      const opt = opts[i % opts.length] || opts[0];
      if (opt) setTimeout(() => send({ t: 'vote', key: opt.id }), 100 + i * 60);
    }
  }, { name: BOTS[i][0], emoji: BOTS[i][1] });
}
function grandma() {
  let did = null;
  client('grandma', (s, send) => {
    const key = s.phase + s.idx + (s.gallery ? '|' + s.gallery.batch : '');
    if ((s.phase === 'answer' || s.phase === 'read') && s.item.type !== 'image' && s.grandmaAnswer == null && did !== key && TARGET !== 'answer' && TARGET !== 'read') {
      did = key;
      const v = s.item.type === 'fibbage' ? TRUTH : s.item.type === 'number' ? GNUM : s.pickOptions[1] || s.pickOptions[0];
      setTimeout(() => send({ t: 'answer', value: v }), 250);
    }
    if (s.phase === 'galleryVote' && !s.grandmaPick && did !== key && TARGET !== 'galleryVote') { did = key; const im = s.images.find((x) => x.status === 'done'); if (im) setTimeout(() => send({ t: 'answer', value: im.id }), 300); }
  });
}
function mc() {
  let started = false, holding = false, sentFor = null;
  client('mc', (s, send) => {
    if (holding) return;
    const key = [s.phase, s.idx, s.step, s.galleryStep, s.voteOpen].join('|');
    const hold = () => { holding = true; console.log(`HOLDING at ${s.phase} idx=${s.idx} step=${s.step} for ${HOLD}s`); setTimeout(() => process.exit(0), HOLD * 1000); };
    const send1 = (cmd, arg) => { if (sentFor === key + cmd) return; sentFor = key + cmd; setTimeout(() => send({ t: 'mc', cmd: cmd.replace(/\d+$/, ''), arg }), 150); };
    const galleryIdx = s.playlist ? s.playlist.findIndex((q) => q.type === 'gallery') : -1;
    const imageIdx = s.playlist ? s.playlist.findIndex((q) => q.type === 'image') : -1;
    switch (s.phase) {
      case 'lobby':
        if (s.players.filter((p) => p.connected).length < BOTS.length || !s.grandmaConnected) return;
        if (started) return; started = true;
        if (TARGET === 'lobby') return hold();
        return send1('goto', TARGET === 'final' ? s.total - 1 : GALLERY_TARGETS.has(TARGET) ? imageIdx : ITEM);
      case 'slide': return send1('next');
      case 'read': if (TARGET === 'read') return hold(); return send1('go');
      case 'answer': if (TARGET === 'answer') return hold(); if (s.answeredCount >= BOTS.length && (s.grandmaAnswered || s.item.type === 'image')) send1('next'); return;
      case 'sorting': return;
      case 'vote': if (TARGET === 'voteReady' && !s.voteOpen) return hold(); if (!s.voteOpen) return send1('go'); if (TARGET === 'vote') return hold(); if (s.votedCount >= BOTS.length) send1('next'); return;
      case 'reveal': case 'galleryReveal': { const st = s.steps[s.step]; if (st && st.kind === TARGET) return hold(); if (s.step >= s.stepCount - 1 && !['scores', 'final'].includes(TARGET)) { console.error('never hit step', TARGET, 'steps:', s.steps.map((x) => x.kind)); process.exit(1); } return send1('next'); }
      case 'scores': if (TARGET === 'scores') return hold(); if (TARGET === 'final') return send1('next'); console.error('missed target', TARGET); return process.exit(1);
      case 'imageQueued': if (TARGET === 'imageQueued') return hold(); return send1('goto', galleryIdx);
      case 'galleryWait': return;
      case 'galleryShow': if (TARGET === 'galleryShow') return hold(); return send1('next' + s.galleryStep);
      case 'galleryVote': if (TARGET === 'galleryVote') return hold(); if (s.votedCount >= BOTS.length && s.grandmaAnswered) send1('next'); return;
      case 'final': if (TARGET === 'final') return hold(); return;
    }
  });
}
const mcSend = client('mc', () => {});
setTimeout(() => { mcSend({ t: 'mc', cmd: 'newgame' }); }, 300);
setTimeout(() => { for (let i = 0; i < BOTS.length; i++) setTimeout(() => bot(i), i * 40); grandma(); }, 600);
setTimeout(mc, 900);
setTimeout(() => { console.error('stage timed out'); process.exit(1); }, 45000 + HOLD * 1000);
