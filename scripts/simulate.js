'use strict';
// Fake party: N bots + a fake Grandma + an auto-MC play a full game against a running server.
// Start the server with MOCK_IMAGES=1 so the picture round costs nothing.
// Usage: URL=ws://localhost:4060 SECRET=party60 BOTS=8 FAST=1 node scripts/simulate.js
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:4060';
const SECRET = process.env.SECRET || 'party60';
const N = Number(process.env.BOTS || 8);
const FAST = process.env.FAST === '1';
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const NAMES = ['Uncle Dave', 'Aunt Lisa', 'Cousin Max', 'Tiny Tim', 'Aunt Meg', 'Big Steve', 'Lil Ava', 'Grandpa', 'Nephew Ky', 'Niece Zo', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Pat', 'Drew', 'Jess', 'Alex'];
const EMO = ['🦄', '🐸', '🦖', '🐙', '🦊', '🐼', '🦁', '🐨', '🐷', '🦩', '🐢', '🦋'];
const LIES = ['stealing a goose', 'Stealing a goose!', 'tax fraud', 'a bar fight', 'too many cats', 'jaywalking', 'jay walking', 'yelling at a ref', 'buying a boat', 'a timeshare', 'lying to grandpa', 'sneaking out', 'rocky road', 'rocky road w/ bananas', 'Rocky Road with bananas', 'mint', 'her keys', 'her phone'];
const TRUTHS = ['jaywalking', 'rocky road with bananas', 'sneaking out', 'her keys', 'a broken watch', 'may bite', 'her stretchy pants'];
const PROMPTS = ['Grandma dancing on a table in a silky purple tracksuit', 'Grandma asleep in a dark closet surrounded by polyester', 'Grandma returning a mountain of gifts to a store', 'Grandma sunbathing while a masseuse works on her scalp', 'Grandma with her bra over her shirt, a stranger asking if she lost a bet', 'this one should fail on purpose', 'Grandma eating a baked potato the size of a car', 'Grandma searching for her keys with a beeping Tile'];
let done = false;

function client(role, onState, extra = {}, onAck) {
  const ws = new WebSocket(URL);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('open', () => send({ t: 'hello', role, secret: SECRET, ...extra }));
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'state') onState(m, send); else if (m.t === 'error') { console.error(role, m.error); process.exit(1); } else if (m.t === 'ack') { if (!m.ok) console.log(`  [${role}${extra.name ? ':' + extra.name : ''}] rejected: ${m.error}`); if (onAck) onAck(m, send); } });
  ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
  return send;
}
function bot(name, emoji) {
  let busy = null;
  const delay = () => (FAST ? rnd(50, 300) : rnd(1000, 6000));
  client('player', (s, send) => {
    const me = s.me; if (!me) return;
    const key = s.phase + s.idx + (s.gallery ? '|' + s.gallery.batch : '');
    if (s.phase === 'answer' && me.answer == null && busy !== key) {
      busy = key;
      setTimeout(() => {
        const it = s.item; let v;
        if (it.type === 'fibbage') v = Math.random() < 0.15 ? pick(TRUTHS) : pick(LIES);
        else if (it.type === 'number') v = Math.floor(rnd(0, 12));
        else if (it.type === 'image') v = { memory: 'That one Thanksgiving', scene: pick(PROMPTS) };
        else v = pick(s.pickOptions);
        send({ t: 'answer', value: v });
      }, delay());
    }
    if (s.phase === 'vote' && !me.vote && !me.autoTruth && busy !== key) {
      busy = key;
      const opts = s.options.filter((o) => !o.mine);
      if (opts.length) setTimeout(() => send({ t: 'vote', key: pick(opts).key }), delay());
    }
    if (s.phase === 'galleryVote' && !me.vote && busy !== key) {
      busy = key;
      const opts = s.images.filter((i) => !i.mine);
      if (opts.length) setTimeout(() => send({ t: 'vote', key: pick(opts).id }), delay());
    }
  }, { name, emoji }, (m, send) => { if (m.matchedTruth) { console.log(`  [${name}] wrote the truth, writing a lie instead`); setTimeout(() => send({ t: 'answer', value: pick(LIES.filter((l) => !TRUTHS.includes(l.toLowerCase()))) }), FAST ? 100 : 1500); } });
}
function grandma() {
  let busy = null;
  client('grandma', (s, send) => {
    const key = s.phase + s.idx + (s.gallery ? '|' + s.gallery.batch : '');
    if ((s.phase === 'answer' || s.phase === 'read') && s.item.type !== 'image' && s.grandmaAnswer == null && busy !== key) {
      busy = key;
      setTimeout(() => {
        const it = s.item; let v;
        if (it.type === 'fibbage') v = pick(TRUTHS); else if (it.type === 'number') v = Math.floor(rnd(0, 12)); else v = pick(s.pickOptions);
        send({ t: 'answer', value: v });
      }, FAST ? rnd(50, 400) : rnd(2000, 8000));
    }
    if (s.phase === 'galleryVote' && !s.grandmaPick && busy !== key) { busy = key; setTimeout(() => send({ t: 'answer', value: pick(s.images).id }), FAST ? 200 : 4000); }
  });
}
function mc() {
  let last = null, t = null;
  client('mc', (s, send) => {
    const key = [s.phase, s.idx, s.step, s.galleryStep, s.voteOpen].join('|');
    if (key === last) return; last = key;
    clearTimeout(t);
    const label = s.item ? (s.item.prompt || s.item.heading || s.item.type) : '';
    console.log(`[${s.phase}] idx=${s.idx} step=${s.step} players=${s.players.length} ${label}`);
    if (s.phase === 'vote') console.log('   options:', s.options.map((o) => o.text).join(' | '), s.sortInfo ? `(sorted by ${s.sortInfo.source})` : '');
    if (s.phase === 'reveal' || s.phase === 'galleryReveal') { const st = s.steps[s.step]; if (st) console.log('   reveal:', st.kind, st.text || st.value || (st.lies ? st.lies.length + ' lies' : '') || (st.ranking ? st.ranking.map((r) => r.votes).join(',') : '')); }
    if (s.phase === 'scores') console.log('   top3:', s.leaderboard.slice(0, 3).map((p) => `${p.name} ${p.score} (+${p.delta})`).join(', '), '| 🧠', s.awards.knows && s.awards.knows.name, '🎭', s.awards.fooler && s.awards.fooler.name);
    const cmd = (c, ms) => { t = setTimeout(() => send({ t: 'mc', cmd: c }), FAST ? 30 : ms); };
    if (s.phase === 'lobby') { if (s.players.length >= N && s.grandmaConnected) cmd('next', 1500); else last = null; }
    else if (s.phase === 'read') cmd('go', 1500);
    else if (s.phase === 'vote' && !s.voteOpen) cmd('go', 2000);
    else if (s.phase === 'slide' || s.phase === 'imageQueued') cmd('next', 2000);
    else if (s.phase === 'reveal' || s.phase === 'galleryReveal' || s.phase === 'galleryShow') cmd('next', 2500);
    else if (s.phase === 'scores') cmd('next', 3000);
    else if (s.phase === 'galleryVote') { t = setTimeout(() => send({ t: 'mc', cmd: 'next' }), FAST ? 2500 : 15000); }
    else if (s.phase === 'final') { console.log('OVERALL:', s.leaderboard[0].name, s.leaderboard[0].score, '| 🧠 knows best:', s.awards.knows && s.awards.knows.name, '| 🎭 impersonator:', s.awards.fooler && s.awards.fooler.name); done = true; setTimeout(() => process.exit(0), 300); }
  });
}
console.log(`simulating ${N} players + Grandma + MC against ${URL}`);
const resetSend = client('mc', () => {});
setTimeout(() => resetSend({ t: 'mc', cmd: 'newgame' }), 300);
for (let i = 0; i < N; i++) setTimeout(() => bot(NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), EMO[i % EMO.length]), 600 + i * 100);
setTimeout(grandma, 900);
setTimeout(mc, 1200);
setTimeout(() => { if (!done) { console.error('simulation timed out'); process.exit(1); } }, FAST ? 120000 : 30 * 60 * 1000);
