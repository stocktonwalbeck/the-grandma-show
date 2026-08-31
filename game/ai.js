'use strict';
// OpenAI helpers: answer grouping (dedupe) and image generation. Also a no-cost mock image generator.
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey(root, keyFile) {
  const env = (process.env.GRANDMA_OPENAI_KEY || '').trim();
  if (env) return env;
  const p = path.join(root, keyFile || '.openai-key');
  if (fs.existsSync(p)) { const k = fs.readFileSync(p, 'utf8').trim(); if (k && k.startsWith('sk-')) return k; }
  return null;
}

async function chatJSON({ apiKey, model }, system, user, timeoutMs = 9000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return JSON.parse(j.choices[0].message.content);
  } finally { clearTimeout(t); }
}

const DEDUPE_SYSTEM = `You group answers for a party game about one specific person ("Grandma").
You receive the question, the TRUE answer (id "TRUTH") and the players' answers (lies or guesses).
Merge answers that mean the same thing: spelling mistakes, typos, abbreviations (w/ = with), capitalization, word order, singular/plural, filler words like "the" or "her".
Do NOT merge answers that differ in a real detail. "rocky road" and "rocky road with bananas" are different. "blue" and "light blue" are different. "her keys" and "her phone" are different.
Any player answer that means the same as the TRUE answer goes into the TRUTH group.
Every id must appear in exactly one group. Never drop an id.
"display" for the TRUTH group must be the true answer's exact text. For other groups, use the best-spelled, most complete version of that group's wording (fix obvious typos, keep the player's tone). Keep displays under 80 characters.
Return only JSON: {"groups":[{"ids":["id1","id2"],"display":"text"}]}`;

async function dedupeAnswers(opts, { prompt, truth, lies }) {
  const user = JSON.stringify({ question: prompt, answers: [{ id: 'TRUTH', text: truth }, ...lies.map((l) => ({ id: l.id, text: l.text }))] });
  const out = await chatJSON(opts, DEDUPE_SYSTEM, user);
  const groups = Array.isArray(out.groups) ? out.groups : null;
  if (!groups) throw new Error('bad dedupe output');
  return groups.map((g) => ({ ids: (g.ids || []).map(String), display: typeof g.display === 'string' ? g.display.trim().slice(0, 80) : undefined }));
}

// approx $ per 1024x1024 image (gpt-image-1 numbers are published; others derived from token prices)
// measured 2026-08-30 with 3 reference photos: 1.5 medium = 582 img-in + 1056 img-out tokens (~$0.04); mini medium ~$0.015
const COST = {
  'gpt-image-1': { low: 0.03, medium: 0.08, high: 0.20 },
  'gpt-image-1.5': { low: 0.02, medium: 0.04, high: 0.15 },
  'gpt-image-2': { low: 0.02, medium: 0.04, high: 0.14 },
  'gpt-image-1-mini': { low: 0.01, medium: 0.015, high: 0.04 },
};
const estimateImageCost = (model, quality) => (COST[model] && COST[model][quality]) || null;

function friendlyImageError(status, text) {
  const t = (text || '').toLowerCase();
  if (t.includes('moderation') || t.includes('safety') || t.includes('content_policy') || t.includes('rejected')) return 'The AI refused to draw this one (content rules)';
  if (status === 401) return 'OpenAI key is wrong or missing';
  if (status === 429) return 'OpenAI rate limit or billing problem';
  if (status === 400 && t.includes('model')) return 'Image model not available on this account';
  return `OpenAI error ${status}`;
}

function refFiles(o) {
  const list = Array.isArray(o.refPaths) ? o.refPaths : o.refPath ? [o.refPath] : [];
  return list.filter((p) => p && fs.existsSync(p));
}
const mimeOf = (p) => { const ext = path.extname(p).toLowerCase(); return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'; };

async function generateImage(o, prompt, meta) {
  const refs = refFiles(o);
  const model = o.model, quality = o.quality, size = o.size || '1024x1024';
  let res;
  if (refs.length) {
    const full = `${o.refPrefix || 'The woman in the reference photo(s) is the main character. Keep her face clearly recognizable as the same person.'} ${o.promptPrefix || ''}${prompt}`;
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', full); fd.append('size', size); fd.append('quality', quality); fd.append('n', '1');
    if (o.inputFidelity) fd.append('input_fidelity', o.inputFidelity);
    for (const r of refs) fd.append('image[]', new Blob([fs.readFileSync(r)], { type: mimeOf(r) }), path.basename(r));
    res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}` }, body: fd });
  } else {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: (o.promptPrefix || '') + prompt, size, quality, n: 1 }),
    });
  }
  if (!res.ok) { const text = await res.text(); throw new Error(friendlyImageError(res.status, text)); }
  const j = await res.json();
  const d = j.data && j.data[0];
  if (!d) throw new Error('No image returned');
  let buf;
  if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
  else if (d.url) buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
  else throw new Error('No image data');
  const file = `${meta.id}.png`;
  fs.writeFileSync(path.join(o.outDir, file), buf);
  return { url: `/images/${file}`, usage: j.usage || null };
}

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function mockImage(o, prompt, meta) {
  await sleep(800 + Math.random() * 2500);
  if (/\bfail\b/i.test(prompt)) throw new Error('The AI refused to draw this one (content rules)');
  const emo = ['👵', '💃', '🌻', '🧴', '🍦', '🔑', '🎁', '🛋️', '🌞', '🦨'][Math.floor(Math.random() * 10)];
  const h = Math.floor(Math.random() * 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,45%)"/><stop offset="1" stop-color="hsl(${(h + 60) % 360},70%,30%)"/></linearGradient></defs>
<rect width="1024" height="1024" fill="url(#g)"/>
<text x="512" y="470" font-size="320" text-anchor="middle">${emo}</text>
<foreignObject x="64" y="600" width="896" height="360"><div xmlns="http://www.w3.org/1999/xhtml" style="font:bold 46px -apple-system,Helvetica,Arial,sans-serif;color:#fff;text-align:center;line-height:1.25">${escXml(prompt)}</div></foreignObject>
<text x="512" y="60" font-size="30" text-anchor="middle" fill="#fff8" font-family="Helvetica,Arial">MOCK IMAGE (no OpenAI key)</text></svg>`;
  const file = `${meta.id}.svg`;
  fs.writeFileSync(path.join(o.outDir, file), svg);
  return { url: `/images/${file}` };
}

module.exports = { loadKey, dedupeAnswers, generateImage, mockImage, estimateImageCost, refFiles };
