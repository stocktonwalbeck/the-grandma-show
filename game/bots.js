'use strict';
// Server-side test players for solo rehearsals. They join, write lies, vote, and write picture prompts
// with human-like delays so the MC can watch the counters move. Never used at the real party.
const NAMES = [['Bot Dave', '🤖'], ['Bot Lisa', '🤖'], ['Bot Max', '🤖'], ['Bot Tim', '🤖'], ['Bot Meg', '🤖'], ['Bot Steve', '🤖'], ['Bot Ava', '🤖'], ['Bot Zo', '🤖']];
const LIES = ['Jaywalking', 'jay walking', 'Stealing a goose', 'stealing a gooose', 'Tax fraud', 'Too many cats', 'Yelling at a ref', 'Punching a mime', 'Rocky road', 'Rocky road w/ bananas', 'rocky road with bananas', 'Mint', 'Her keys', 'Her phone', 'A timeshare', 'Sneaking out', 'Polyester', 'The closet', 'Returning a gift', 'A baked potato'];
const PROMPTS = ['Grandma dancing on a table at Arctic Circle in a silky purple tracksuit', 'Grandma asleep in a pitch-black closet on a pile of polyester', 'Grandma returning a mountain of gifts to the store with a smile', 'Grandma sunbathing while getting a scalp massage', 'Grandma searching for her keys with a beeping Tile', 'Grandma eating a baked potato the size of a car'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];

function attachBots(engine, { fast = false } = {}) {
  const scheduled = new Set();
  const delay = () => {
    if (fast) return rnd(200, 800);
    const left = engine.deadline ? engine.deadline - Date.now() : 15000;
    return rnd(1500, Math.max(3000, left * 0.85)); // trickle in across most of the clock
  };
  function tick() {
    const bots = [...engine.players.values()].filter((p) => p.bot);
    if (!bots.length) return;
    const it = engine.item;
    for (const b of bots) {
      const key = `${engine.round}|${engine.phase}|${engine.gallery ? engine.gallery.b : ''}|${b.id}`;
      if (scheduled.has(key)) continue;
      if (engine.phase === 'answer' && !engine.answers.has(b.id) && !engine.autoTruth.has(b.id)) {
        scheduled.add(key);
        setTimeout(() => {
          if (engine.phase !== 'answer' || engine.answers.has(b.id)) return;
          let v;
          if (it.type === 'fibbage') v = pick(LIES);
          else if (it.type === 'number') v = Math.floor(rnd(0, 12));
          else if (it.type === 'image') v = { memory: pick(['That one Thanksgiving', 'The lake trip', 'Christmas morning 2009', 'The famous bra day']), scene: pick(PROMPTS) };
          else v = pick(engine.pickOpts);
          const r = engine.submitAnswer(b.id, v);
          if (r.matchedTruth) engine.submitAnswer(b.id, pick(LIES));
        }, delay());
      } else if (engine.phase === 'vote' && engine.voteOpen && !engine.votes.has(b.id) && !engine.autoTruth.has(b.id)) {
        scheduled.add(key);
        setTimeout(() => { if (engine.phase !== 'vote') return; const opts = engine.options.filter((o) => !o.authors.includes(b.id)); if (opts.length) engine.submitVote(b.id, pick(opts).key); }, delay());
      } else if (engine.phase === 'galleryVote' && !engine.votes.has(b.id)) {
        scheduled.add(key);
        setTimeout(() => { if (engine.phase !== 'galleryVote') return; const opts = engine._batch().images.filter((i) => i.pid !== b.id); if (opts.length) engine.submitVote(b.id, pick(opts).id); }, delay());
      }
    }
    if (scheduled.size > 2000) scheduled.clear();
  }
  const iv = setInterval(tick, 500);
  return {
    add(n) {
      const have = [...engine.players.values()].filter((p) => p.bot).length;
      const EXTRA = ['Bot Rae', 'Bot Jo', 'Bot Kai', 'Bot Sam', 'Bot Ash', 'Bot Bo', 'Bot Ky', 'Bot Zed', 'Bot Ivy', 'Bot Mo', 'Bot Lou', 'Bot Sky', 'Bot Ren', 'Bot Ty', 'Bot Vi', 'Bot Ola', 'Bot Ned', 'Bot Fay', 'Bot Gus', 'Bot Hal', 'Bot Ida', 'Bot Jax'];
      for (let i = 0; i < n; i++) { const k = have + i; const [name, emoji] = k < NAMES.length ? NAMES[k] : [EXTRA[(k - NAMES.length) % EXTRA.length], '🤖']; engine.addPlayer(name, emoji, { bot: true }); }
    },
    stop() { clearInterval(iv); },
  };
}
module.exports = { attachBots };
