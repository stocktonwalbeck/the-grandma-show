(function () {
  const LS = { id: 'g60_id', name: 'g60_name', emoji: 'g60_emoji', device: 'g60_device' };
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.avatarInner = (p) => (p && p.photo ? `<img class="ph" src="${esc(p.photo)}" alt="">` : `<span class="em">${p ? p.emoji : '👻'}</span>`);
  // shrink a camera photo to a small square JPEG data URL (about 8 KB)
  window.shrinkPhoto = (file, size = 160) => new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = size; c.height = size; const x = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        // portrait selfies: crop from near the top so foreheads don't get chopped
        const sy = img.height > img.width ? (img.height - s) * 0.08 : (img.height - s) / 2;
        x.drawImage(img, (img.width - s) / 2, sy, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('could not read the photo')); img.src = url;
  });
  window.blank = (t) => esc(t).replace(/_{2,}/g, '<span class="blank">____</span>');
  window.EMOJIS = ['🦄','🐸','🦖','🐙','🦊','🐼','🦁','🐨','🐷','🦩','🐢','🦋','🐝','🦈','🐵','🦉','🐰','🦔','🐧','🦜','🐺','🦝','🐮','🦒','🐲','👽','🤖','🎃','🍕','🌮','🍩','🦞'];

  // WebSocket client with auto-reconnect and clock sync. Roles: player | grandma | tv | mc
  window.GameClient = function ({ role, secret, onState, onEvent }) {
    let ws = null, offset = 0, tries = 0, connected = false;
    // one player per device: a permanent random id for this browser, sent with every hello
    let device = ls.get(LS.device);
    if (!device) { device = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); ls.set(LS.device, device); }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const hello = () => {
      const h = { t: 'hello', role, secret };
      h.device = device;
      if (role === 'player') { h.id = ls.get(LS.id); h.name = ls.get(LS.name); h.emoji = ls.get(LS.emoji); }
      send(h);
    };
    function connect() {
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => { tries = 0; connected = true; hello(); onEvent && onEvent({ t: 'open' }); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'state') { offset = m.now - Date.now(); onState(m); }
        else if (m.t === 'joined') ls.set(LS.id, m.id);
        else onEvent && onEvent(m);
      };
      ws.onclose = () => { connected = false; onEvent && onEvent({ t: 'close' }); setTimeout(connect, Math.min(4000, 400 + tries++ * 400)); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    connect();
    const wake = () => { if (!ws || ws.readyState > 1) { try { connect(); } catch {} } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
    window.addEventListener('pageshow', wake); window.addEventListener('focus', wake); window.addEventListener('online', wake);
    return {
      send, now: () => Date.now() + offset, isConnected: () => connected,
      join(name, emoji) { ls.set(LS.name, name); ls.set(LS.emoji, emoji); send({ t: 'hello', role: 'player', name, emoji, id: ls.get(LS.id), device }); },
      rename(name, emoji) { ls.set(LS.name, name); ls.set(LS.emoji, emoji); send({ t: 'rename', name, emoji }); },
      forget() { ls.del(LS.id); },
      async uploadPhoto(dataUrl) {
        const id = ls.get(LS.id); if (!id) return { ok: false, error: 'not joined yet' };
        try { const r = await fetch('/api/photo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, device, data: dataUrl }) }); return await r.json(); }
        catch (e) { return { ok: false, error: e.message }; }
      },
      playerId: () => ls.get(LS.id),
      stored: () => ({ name: ls.get(LS.name) || '', emoji: ls.get(LS.emoji) || '' }),
    };
  };

  // Countdown ring. el contains .ring-num. Call .set(deadlineMs, nowFn) every state update.
  window.TimerRing = function (el) {
    let deadline = null, total = 1, nowFn = () => Date.now();
    function tick() {
      if (deadline) {
        const rem = Math.max(0, deadline - nowFn());
        el.querySelector('.ring-num').textContent = Math.ceil(rem / 1000);
        el.style.setProperty('--frac', Math.min(1, rem / total));
        el.classList.toggle('urgent', rem < 10000);
        el.classList.remove('hide');
      } else el.classList.add('hide');
      requestAnimationFrame(tick);
    }
    tick();
    return { set(d, n) { if (n) nowFn = n; if (d && d !== deadline) { deadline = d; total = Math.max(1000, d - nowFn()); } if (!d) deadline = null; } };
  };

  let toastT = null;
  window.toast = (msg) => {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600);
  };
})();
// ?noanim=1 disables entrance animations (used for screenshots / QA)
if (new URLSearchParams(location.search).has('noanim')) document.documentElement.classList.add('noanim');
