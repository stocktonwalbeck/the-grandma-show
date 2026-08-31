'use strict';
// Local (no-AI) answer matching: typos, abbreviations, plurals, word order.
const STOP = new Set(['a', 'an', 'the', 'her', 'his', 'my', 'some']);
function norm(s) {
  let t = String(s ?? '').toLowerCase();
  t = t.replace(/\bw\/?\b/g, ' with ').replace(/&/g, ' and ').replace(/[’']/g, '');
  t = t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter((w) => w && !STOP.has(w));
  return words.map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const tolFor = (L) => (L >= 12 ? 3 : L >= 8 ? 2 : L >= 5 ? 1 : 0);
function sameWord(a, b) { if (a === b) return true; const L = Math.max(a.length, b.length); return L >= 4 && lev(a, b) <= (L >= 8 ? 2 : 1); }
function sameText(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (lev(x, y) <= tolFor(Math.max(x.length, y.length))) return true;
  // same set of words, allowing a typo per word, any order
  const xw = x.split(' '), yw = y.split(' ');
  if (xw.length !== yw.length) return false;
  const used = new Set();
  for (const w of xw) { const j = yw.findIndex((v, i) => !used.has(i) && sameWord(w, v)); if (j < 0) return false; used.add(j); }
  return true;
}
function pickDisplay(texts) {
  // the "medoid": closest to everyone else; ties -> capitalized first letter -> longer (more complete)
  if (texts.length === 1) return texts[0];
  let best = texts[0], bestScore = Infinity;
  for (const t of texts) {
    const n = norm(t);
    const dist = texts.reduce((a, o) => a + lev(n, norm(o)), 0);
    const score = dist * 1000 - (/^[A-Z]/.test(t) ? 500 : 0) - Math.min(t.length, 400);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}
// lies: [{id, text}] -> [{ids, display}] ; the truth has id 'TRUTH'
function localGroups(truth, lies) {
  const items = [{ id: 'TRUTH', text: truth }, ...lies];
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (sameText(items[i].text, items[j].text)) parent[find(i)] = find(j);
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()].map((members) => {
    const truthM = members.find((m) => m.id === 'TRUTH');
    return { ids: members.map((m) => m.id), display: truthM ? truthM.text : pickDisplay(members.map((m) => m.text)) };
  });
}
module.exports = { norm, lev, sameText, localGroups };
