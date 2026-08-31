'use strict';
const assert = require('assert');
const Engine = require('../game/engine');
const { sameText, localGroups } = require('../game/dedupe');

const config = {
  grandmaName: 'Grandma', manualStart: true,
  timers: { fibbage: 0.08, number: 0.08, pick: 0.08, image: 0.08, vote: 0.08, galleryVote: 0.08 },
  points: { truth: 1000, fool: 500, numberClosest: 1000, numberSecond: 500, numberExact: 500, pick: 1000, galleryVote: 500, galleryGrandma: 2000 },
  pickOptions: [], maxAnswerLength: 40, maxPromptLength: 240, imageConcurrency: 2, dedupeTimeoutMs: 500,
};
const playlist = [
  { type: 'fibbage', prompt: 'Grandma got arrested for ____.' },
  { type: 'number', prompt: 'How many tickets?' },
  { type: 'pick', prompt: 'Who?', options: ['Amy', 'Ben', 'Cal'] },
  { type: 'image', prompt: 'Draw Grandma.' },
  { type: 'slide', heading: 'Break' },
  { type: 'fibbage', prompt: 'Final ____.', double: true },
  { type: 'gallery' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);

(async () => {
  // ---- dedupe unit checks
  assert.ok(sameText('Rocky road w/ bananas', 'rocky road with banana'));
  assert.ok(sameText('Rocky Road with bananas', 'rocky raod with bananas'));
  assert.ok(!sameText('rocky road', 'rocky road with bananas'));
  assert.ok(sameText('Blue', 'blue.'));
  assert.ok(sameText('Jaywalking', 'jay walking'));
  assert.ok(!sameText('her keys', 'her phone'));
  assert.ok(sameText('the closet', 'closet'));
  { const eL = new Engine({ config: { ...config, maxAnswerLength: 80 }, playlist: [{ type: 'fibbage', prompt: 'x ____' }], onChange: () => {} });
    const lp = eL.addPlayer('L', 'x'); eL.setGrandmaConnected(true); eL.mc('start'); eL.mc('go');
    const long = 'Running myself into the ground and not knowing it until way too late honestly';
    eL.submitAnswer('grandma', long); assert.equal(eL.grandmaAnswer, long, 'long answers are not cut off');
    eL._clearTimer(); }
  const lg = localGroups('Rocky road with bananas', [{ id: 'a', text: 'rocky road w bananas' }, { id: 'b', text: 'Rocky road' }, { id: 'c', text: 'mint' }, { id: 'd', text: 'Mint!' }]);
  assert.equal(lg.length, 3);
  assert.deepEqual(lg.find((g) => g.ids.includes('TRUTH')).ids.sort(), ['TRUTH', 'a']);
  assert.deepEqual(lg.find((g) => g.ids.includes('c')).ids.sort(), ['c', 'd']);

  let changes = 0;
  const gen = (prompt, meta) => sleep(30).then(() => { if (/fail/.test(prompt)) throw new Error('refused'); return { url: `/images/${meta.id}.png` }; });
  let dedupeCalls = 0;
  const dedupe = async (prompt, truth, lies) => { dedupeCalls++; if (dedupeCalls === 1) return [{ ids: ['TRUTH', ...lies.filter((l) => /goose/.test(l.text)).map((l) => l.id)], display: 'x' }, ...lies.filter((l) => !/goose/.test(l.text)).map((l) => ({ ids: [l.id], display: l.text.toUpperCase() }))]; throw new Error('boom'); };
  const e = new Engine({ config, playlist, onChange: () => changes++, dedupe, generateImage: gen });
  const p1 = e.addPlayer('Amy', '🦄'), p2 = e.addPlayer('Ben', '🐸'), p3 = e.addPlayer('Cal', '🦖'), p4 = e.addPlayer('Dee', '🐙');
  e.setGrandmaConnected(true);

  // ---- fibbage with read/go, matchedTruth, AI grouping
  e.mc('start');
  assert.equal(e.phase, 'read');
  assert.equal(e.submitAnswer(p1, 'x').ok, false, 'players locked during read');
  assert.equal(e.submitAnswer('grandma', 'stealing a goose').ok, true, 'grandma can answer during read');
  assert.equal(e.mc('go').ok, true); assert.equal(e.phase, 'answer');
  const r1 = e.submitAnswer(p1, 'Stealing a Goose!');
  assert.equal(r1.matchedTruth, true); assert.ok(e.autoTruth.has(p1)); assert.equal(e.answers.has(p1), false);
  assert.equal(e.submitAnswer(p1, 'tax fraud').ok, true, 'then writes a lie');
  e.submitAnswer(p2, 'goose theft'); e.submitAnswer(p3, 'jaywalking');
  assert.equal(e.phase, 'answer');
  e.submitAnswer(p4, 'punching a mime');
  assert.equal(e.phase, 'sorting');
  await tick();
  assert.equal(e.phase, 'vote'); assert.equal(dedupeCalls, 1);
  assert.equal(e.voteOpen, false, 'answers shown, voting waits for GO');
  assert.equal(e.submitVote(p3, e.options[0].key).ok, false, 'no votes before GO');
  assert.equal(e.mc('go').ok, true); assert.equal(e.voteOpen, true); assert.ok(e.deadline);
  assert.equal(e.lastSortInfo.source, 'ai');
  assert.ok(e.autoTruth.has(p2), 'AI merged goose theft into the truth');
  assert.equal(e.options.length, 4, 'truth + 3 lies');
  const truth = e.options.find((o) => o.isTruth); assert.equal(truth.text, 'stealing a goose', 'truth keeps her exact text');
  const tax = e.options.find((o) => o.authors.includes(p1)); assert.equal(tax.text, 'TAX FRAUD', 'AI display used');
  assert.equal(e.submitVote(p1, tax.key).ok, false, 'own lie');
  assert.equal(e.submitVote(p2, tax.key).ok, false, 'autoTruth cannot vote');
  assert.equal(e.submitVote(p3, tax.key).ok, true);
  assert.equal(e.phase, 'vote', 'p4 still to vote');
  e.submitVote(p4, truth.key);
  assert.equal(e.phase, 'reveal', 'p1 and p2 sit out (they matched the truth)');
  const P = (id) => e.players.get(id);
  // p1 & p2 wrote the exact truth: 1000 truth + 500 echo per truth-finder (p4 found it => 500 each)
  assert.equal(P(p1).truthPts, 1000); assert.equal(P(p1).foolPts, 500 + 500, 'tax-fraud fool + truth echo');
  assert.equal(P(p2).truthPts, 1000); assert.equal(P(p2).foolPts, 500, 'truth echo only');
  assert.equal(P(p3).foolPts, 0); assert.equal(P(p4).truthPts, 1000);
  assert.equal(P(p1).score, 2000);
  while (e.phase === 'reveal') e.mc('next');
  assert.equal(e.phase, 'scores');
  const v = e.view('tv'); assert.equal(v.awards.knows.tie, true); assert.equal(v.awards.fooler.id, p1);

  // ---- number (dedupe not called), manual go
  e.mc('next'); assert.equal(e.phase, 'read'); e.mc('go');
  e.submitAnswer(p1, '3'); e.submitAnswer(p2, 5); e.submitAnswer(p3, '1'); e.submitAnswer(p4, 10);
  e.submitAnswer('grandma', '3');
  assert.equal(e.phase, 'reveal'); assert.equal(e.lastDeltas[p1], 1500); assert.equal(e.lastDeltas[p2], 500);
  e.mc('next'); e.mc('next'); assert.equal(e.phase, 'scores');

  // ---- pick
  e.mc('next'); e.mc('go');
  e.submitAnswer('grandma', 'Ben'); e.submitAnswer(p1, 'Ben'); e.submitAnswer(p2, 'Amy'); e.submitAnswer(p3, 'Ben'); e.submitAnswer(p4, 'Cal');
  assert.equal(e.phase, 'reveal'); assert.deepEqual(e.steps[1].winners.sort(), [p1, p3].sort());
  e.mc('next'); e.mc('next');

  // ---- image round
  e.mc('next'); assert.equal(e.item.type, 'image'); e.mc('go');
  assert.equal(e.submitAnswer('grandma', 'nope').ok, false, 'grandma is the judge');
  e.submitAnswer(p1, { memory: 'That one Christmas', scene: 'Grandma dancing' }); e.submitAnswer(p2, 'Grandma in the closet'); e.submitAnswer(p3, 'this will fail');
  assert.equal(e.phase, 'answer');
  e.submitAnswer(p4, 'Grandma returning a gift');
  assert.equal(e.phase, 'imageQueued'); assert.equal(e.imageJobs.size, 4);
  { const j = [...e.imageJobs.values()].find((x) => x.pid === p1); assert.equal(j.memory, 'That one Christmas'); assert.equal(j.prompt, 'Grandma dancing'); }
  assert.equal([...e.imageJobs.values()].filter((j) => j.status === 'running').length, 2, 'concurrency 2');
  e.mc('next'); assert.equal(e.phase, 'slide');
  // final fibbage with local dedupe fallback (ai throws) + timer expiry + waiting on grandma + double
  e.mc('next'); assert.equal(e.phase, 'read'); e.mc('go');
  e.setConnected(p4, false);
  e.submitAnswer(p1, 'a'); e.submitAnswer(p2, 'b'); e.submitAnswer(p3, 'c');
  await sleep(150);
  assert.equal(e.waitingOnGrandma, true);
  assert.equal(e.mc('next').ok, false);
  e.submitAnswer('grandma', 'the truth');
  assert.equal(e.phase, 'sorting'); await tick(); assert.equal(e.phase, 'vote');
  assert.ok(e.lastSortInfo.source.startsWith('local'), 'fell back to local: ' + e.lastSortInfo.source);
  e.mc('next'); assert.equal(e.voteOpen, true, 'NEXT during a closed vote opens it');
  const before = P(p1).score;
  e.submitVote(p1, e.options.find((o) => o.isTruth).key);
  await sleep(150);
  assert.equal(e.phase, 'reveal'); assert.equal(P(p1).score - before, 2000);
  while (e.phase === 'reveal') e.mc('next');
  // ---- gallery
  await sleep(150);
  e.setConnected(p4, true);
  e.mc('next'); // gallery item
  assert.equal(e.phase, 'galleryShow', 'images settled -> show');
  assert.ok(e.groups && e.groups.length === 1, '4 players -> 1 group of 4: ' + JSON.stringify(e.groups));
  assert.equal(e.gallery.batches.length, 1); assert.equal(e.gallery.batches[0].images.length, 4);
  assert.equal([...e.imageJobs.values()].filter((j) => j.status === 'failed').length, 1);
  for (let i = 0; i < 3; i++) e.mc('next');
  assert.equal(e.phase, 'galleryShow');
  e.mc('next'); assert.equal(e.phase, 'galleryVote');
  const imgOf = (pid) => e.gallery.batches[0].images.find((i) => i.pid === pid);
  assert.equal(e.submitVote(p1, imgOf(p1).id).ok, false, 'no self vote');
  e.submitVote(p1, imgOf(p2).id); e.submitVote(p2, imgOf(p1).id); e.submitVote(p3, imgOf(p1).id); e.submitVote(p4, imgOf(p1).id);
  assert.equal(e.phase, 'galleryVote', 'waiting on grandma');
  assert.equal(e.submitAnswer('grandma', imgOf(p2).id).ok, true);
  assert.equal(e.phase, 'galleryReveal');
  assert.equal(e.steps[0].ranking[0].pid, p1); assert.equal(e.steps[0].ranking[0].votes, 3);
  assert.equal(e.steps[2].kind, 'artists'); assert.equal(e.steps[2].artists.length, 4);
  assert.equal(e.steps[2].artists[0].pid, p2, 'her pick sorts first by points'); assert.equal(e.steps[2].artists[0].grandmaPick, true);
  assert.equal(e.lastDeltas[p1], 1500); assert.equal(e.lastDeltas[p2], 500 + 2000);
  assert.equal(P(p2).bonusPts, 2500);
  e.mc('next'); e.mc('next'); e.mc('next'); assert.equal(e.phase, 'scores', 'last batch -> scores');
  assert.ok([...e.imageJobs.values()].every((j) => j.shown), 'jobs marked shown');
  e.mc('next'); assert.equal(e.phase, 'final');
  const fv = e.view('tv'); assert.ok(fv.awards.knows && fv.awards.fooler); assert.equal(e.view('mc').images.length, 4);
  const pv = e.view('player', p1); assert.equal(pv.me.truthPts, P(p1).truthPts);
  // ---- grouping math + multi-batch gallery
  {
    const cfg3 = { ...config, groupSize: 4, timers: { ...config.timers } };
    const e3 = new Engine({ config: cfg3, playlist: [{ type: 'image', prompt: 'pics', prompts: ['A', 'B'] }, { type: 'gallery' }], onChange: () => {}, generateImage: gen });
    const ids = []; for (let i = 0; i < 10; i++) ids.push(e3.addPlayer('P' + i, 'x'));
    e3.setGrandmaConnected(true);
    e3.mc('start'); assert.deepEqual(e3.groups.map((g) => g.length).sort().reverse(), [4, 3, 3], '10 players -> 4,3,3');
    for (const n of [6, 7, 9, 10, 12, 13, 15, 16, 20]) {
      const eG = new Engine({ config: cfg3, playlist: [], onChange: () => {} });
      for (let i = 0; i < n; i++) eG.addPlayer('g' + i, 'x');
      eG._lockGroups();
      const sizes = eG.groups.map((g) => g.length);
      if (!sizes.every((x) => x >= 3 && x <= 4)) throw new Error(`bad group sizes for n=${n}: ${sizes}`);
    }
    const late = e3.addPlayer('Late', 'x');
    e3.mc('go');
    assert.deepEqual(e3.groups.map((g) => g.length).sort(), [3, 4, 4], 'late joiner goes to a smallest group');
    const gps = new Set(ids.map((id) => e3.view('player', id).me.groupPrompt));
    assert.ok([...gps].every((x) => ['A', 'B'].includes(x)), 'every player gets one of the themes (reused in order)');
    for (const id of [...ids, late]) e3.submitAnswer(id, 'pic of grandma ' + id);
    assert.equal(e3.phase, 'imageQueued');
    e3.mc('next'); // gallery -> wait
    assert.equal(e3.phase, 'galleryWait');
    await sleep(400);
    assert.equal(e3.phase, 'galleryShow'); assert.equal(e3.gallery.batches.length, 3);
    const b0 = e3.gallery.batches[0]; assert.equal(b0.prompt, 'A');
    assert.equal(e3.view('tv').images.length, b0.images.length, 'tv sees only the current batch');
    while (e3.phase === 'galleryShow') e3.mc('next');
    assert.equal(e3.phase, 'galleryVote');
    assert.equal(e3.submitVote(ids[0], e3.gallery.batches[1].images[0].id).ok, false, 'cannot vote outside the batch');
    e3.submitAnswer('grandma', b0.images[0].id);
    e3.mc('next'); assert.equal(e3.phase, 'galleryReveal');
    e3.mc('next'); e3.mc('next'); e3.mc('next'); assert.equal(e3.phase, 'galleryShow', 'next batch'); assert.equal(e3.gallery.b, 1); assert.equal(e3.gallery.grandmaPick, null);
    assert.equal(e3.view('mc').images.filter((i) => i.shown).length, b0.images.length);
  }
  // ---- singles grouping: 2+ one-vote lies share a screen, a lone one gets the big card
  {
    const eS = new Engine({ config, playlist: [{ type: 'fibbage', prompt: 's ____' }], onChange: () => {} });
    const ids = []; for (let i = 0; i < 6; i++) ids.push(eS.addPlayer('S' + i, 'x'));
    eS.setGrandmaConnected(true); eS.mc('start'); eS.mc('go');
    eS.submitAnswer('grandma', 'the truth zz');
    const lies = ['lie one', 'lie two', 'lie three', 'lie four', 'lie five', 'lie six'];
    ids.forEach((id, i) => eS.submitAnswer(id, lies[i]));
    await tick();
    eS.mc('go');
    const opt = (t) => eS.options.find((o) => o.text === t);
    eS.submitVote(ids[0], opt('lie two').key); eS.submitVote(ids[1], opt('lie three').key); eS.submitVote(ids[2], opt('lie four').key);
    eS.submitVote(ids[3], opt('lie one').key); eS.submitVote(ids[4], opt('lie one').key); eS.submitVote(ids[5], opt('lie one').key);
    assert.equal(eS.phase, 'reveal');
    assert.equal(eS.steps[0].kind, 'intro');
    assert.equal(eS.steps[1].kind, 'singles'); assert.equal(eS.steps[1].lies.length, 3, 'three one-vote lies share one screen');
    assert.equal(eS.steps[2].kind, 'lie'); assert.equal(eS.steps[2].voters.length, 3, 'the big one gets its own card');
    assert.equal(eS.steps[3].kind, 'truth');
    eS._clearTimer();
  }
  // ---- MC can skip a dead picture round and the gallery degrades gracefully
  {
    const eK = new Engine({ config, playlist: [{ type: 'image', prompt: 'pics', prompts: ['T1'] }, { type: 'gallery' }, { type: 'fibbage', prompt: 'after ____' }], onChange: () => {} });
    const k1 = eK.addPlayer('K1', 'x'); eK.addPlayer('K2', 'x'); eK.setGrandmaConnected(true);
    eK.mc('start'); assert.equal(eK.phase, 'read');
    eK.mc('skip'); // skip the picture round entirely
    assert.equal(eK.phase, 'slide'); assert.ok(/No pictures/i.test(eK.item.heading), 'gallery becomes a harmless slide');
    eK.mc('next'); assert.equal(eK.phase, 'read'); assert.equal(eK.item.prompt, 'after ____', 'game continues');
    eK.mc('go'); eK.submitAnswer('grandma', 'zz'); eK.submitAnswer(k1, 'yy');
    eK.checkInvariants(); eK._clearTimer();
  }
  // ---- fairness invariants on the finished game
  e.checkInvariants();
  // ---- one player per device, unique names, rename
  {
    const e5 = new Engine({ config, playlist, onChange: () => {} });
    const a = e5.addPlayer('Scooby', '🐶', { device: 'dev-1' });
    const b = e5.addPlayer('Scooby', '🐶', { device: 'dev-1' });
    assert.equal(a, b, 'same device -> same player');
    const c = e5.addPlayer('Scooby', '🦴', { device: 'dev-2' });
    assert.equal(e5.players.get(c).name, 'Scooby 2', 'duplicate names get a suffix');
    assert.equal(e5.findByDevice('dev-2'), c);
    assert.equal(e5.renamePlayer(a, 'Scoob', '🐕').ok, true); assert.equal(e5.players.get(a).name, 'Scoob'); assert.equal(e5.players.size, 2, 'rename never adds a player');
    assert.equal(e5.renamePlayer(c, 'Scoob').ok, true); assert.equal(e5.players.get(c).name, 'Scoob 2');
  }
  // ---- snapshot / restore mid-game keeps scores, images, gallery, and pauses the clock
  {
    const snap = JSON.parse(JSON.stringify(e.snapshot()));
    const e6 = new Engine({ config, playlist, onChange: () => {}, generateImage: gen });
    assert.equal(e6.restore(snap), true);
    assert.equal(e6.phase, 'final'); assert.equal(e6.players.size, e.players.size);
    for (const p of e.players.values()) { const q = e6.players.get(p.id); assert.equal(q.score, p.score); assert.equal(q.foolPts, p.foolPts); assert.equal(q.history.length, p.history.length); assert.equal(q.connected, false); }
    assert.equal(e6.imageJobs.size, e.imageJobs.size);
    e6.checkInvariants();
    // mid-answer snapshot -> restored paused with the remaining clock
    const e7 = new Engine({ config: { ...config, timers: { ...config.timers, fibbage: 30 } }, playlist, onChange: () => {} });
    const z = e7.addPlayer('Zed', 'x'); e7.addPlayer('Slow', 'x'); e7.setGrandmaConnected(true); e7.mc('start'); e7.mc('go'); e7.submitAnswer(z, 'a lie'); e7.submitAnswer('grandma', 'truth');
    assert.equal(e7.phase, 'answer');
    const snap2 = JSON.parse(JSON.stringify(e7.snapshot()));
    const e8 = new Engine({ config, playlist, onChange: () => {} }); e8.restore(snap2);
    assert.equal(e8.phase, 'answer'); assert.equal(e8.paused = e8.pausedRemaining != null, true, 'restored clock is paused'); assert.ok(e8.pausedRemaining > 20000);
    assert.equal(e8.answers.get(z), 'a lie'); assert.equal(e8.grandmaAnswer, 'truth');
    assert.equal(e8.mc('pause').paused, false, 'MC resumes'); assert.ok(e8.deadline > Date.now());
    e8._clearTimer();
  }
  // ---- photos survive snapshot; voteOpen survives restore
  {
    const e9 = new Engine({ config, playlist, onChange: () => {} });
    const q = e9.addPlayer('Pic', '🙂'); e9.setPhoto(q, '/photos/x.jpg?v=1');
    const snap = JSON.parse(JSON.stringify(e9.snapshot())); const e10 = new Engine({ config, playlist, onChange: () => {} }); e10.restore(snap);
    assert.equal(e10.players.get(q).photo, '/photos/x.jpg?v=1'); assert.equal(e10.view('tv').players[0].photo, '/photos/x.jpg?v=1');
  }
  // ---- MC controls
  const e2 = new Engine({ config: { ...config, timers: { ...config.timers, fibbage: 2, vote: 2 } }, playlist: [{ type: 'fibbage', prompt: 'x ____' }, { type: 'fibbage', prompt: 'y ____' }], onChange: () => {} });
  const q1 = e2.addPlayer('Amy', '🦄'), b1 = e2.addPlayer('Bot', '🤖', { bot: true });
  assert.equal(e2.view('mc').players.find((p) => p.id === b1).bot, true);
  e2.mc('start'); e2.mc('go');
  assert.equal(e2.mc('pause').paused, true); assert.equal(e2.deadline, null); assert.ok(e2.pausedRemaining > 1000);
  assert.equal(e2.view('tv').paused, true);
  assert.equal(e2.mc('pause').paused, false); assert.ok(e2.deadline > Date.now());
  const d0 = e2.deadline; await sleep(60); e2.mc('restartTimer'); assert.ok(e2.deadline > d0, 'restart resets the clock');
  e2.submitAnswer(q1, 'a lie'); e2.submitAnswer(b1, 'bot lie');
  assert.equal(e2.view('mc').liveAnswers.length, 2);
  assert.equal(e2.mc('removeAnswer', q1).ok, true); assert.equal(e2.answers.has(q1), false);
  assert.equal(e2.mc('grandmaAnswer', 'set by mc').ok, true); assert.equal(e2.grandmaAnswer, 'set by mc');
  assert.equal(e2.view('mc').grandmaAnswer, 'set by mc', 'mc sees her answer in plain text');
  assert.equal(e2.mc('removeAnswer', 'grandma').ok, true); assert.equal(e2.grandmaAnswer, null);
  assert.equal(e2.mc('replay').ok, true); assert.equal(e2.phase, 'read'); assert.equal(e2.answers.size, 0); assert.equal(e2.idx, 0);
  e2.mc('removeBots'); assert.equal(e2.players.size, 1);
  e.mc('reset'); assert.equal(P(p1).score, 0); assert.equal(P(p1).foolPts, 0); assert.equal(e.imageJobs.size, 0);
  console.log('engine tests passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
