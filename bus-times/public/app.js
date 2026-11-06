// Bus times page. Plain JavaScript, no frameworks.
(() => {
  const TZ = 'America/Edmonton';
  const main = document.getElementById('main');
  const live = document.getElementById('announce');
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  const dateKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const longFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let timers = [];

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({ error: 'The server sent a bad answer.' }));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function announce(text) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 60); }
  function clearTimers() { timers.forEach(clearInterval); timers = []; }

  function view(title, ...kids) {
    clearTimers();
    const h1 = h('h1', { tabindex: '-1' }, title);
    main.replaceChildren(h1, ...kids);
    document.title = `${title} - Bus times`;
    const hash = location.hash || '#/';
    for (const a of document.querySelectorAll('nav a')) {
      const on = a.getAttribute('href') === '#/' ? (hash === '#/' || hash === '#') : hash.startsWith(a.getAttribute('href'));
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    h1.focus();
    return h1;
  }

  const fmtTime = (ms, ref) => {
    const t = timeFmt.format(ms);
    return dateKeyFmt.format(ms) === dateKeyFmt.format(ref) ? t : `${dayFmt.format(ms)} ${t}`;
  };
  const stopLine = (s) => [`Stop ${s.code}`, s.routes?.length ? `Routes ${s.routes.join(', ')}` : '', s.distance != null ? `${s.distance} m away` : ''].filter(Boolean).join(' · ');

  function stopList(stops) {
    if (!stops.length) return h('p', null, 'No stops found.');
    return h('ul', { class: 'list' }, stops.map((s) => h('li', null,
      h('a', { href: `#/stop/${encodeURIComponent(s.code)}` }, h('div', { class: 'title' }, s.label), h('div', { class: 'muted' }, stopLine(s))))));
  }

  function errorBox(err) { return h('p', { class: 'error', role: 'alert' }, err.message || String(err)); }

  // ------------------------------------------------------------ saved stops
  async function savedView() {
    view('Saved stops');
    let list;
    try { list = await api('/api/saved'); } catch (err) { main.append(errorBox(err)); return; }
    if (!list.length) { main.append(h('p', null, 'No saved stops yet. Use Find stop or Route to find one, then save it.')); return; }
    let editing = false;
    const ul = h('ul', { class: 'list' });
    const editBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Edit list');
    const draw = () => {
      ul.replaceChildren(...list.map((s, i) => {
        const name = s.nick ? `${s.nick}: ${s.label}` : s.label;
        const li = h('li', null, h('a', { href: `#/stop/${encodeURIComponent(s.code)}` }, h('div', { class: 'title' }, name), h('div', { class: 'muted' }, stopLine(s))));
        if (editing) {
          const act = (body, msg) => async () => {
            try { list = await api('/api/saved', body); draw(); announce(msg); } catch (err) { announce(err.message); }
          };
          li.append(h('div', { class: 'edit' },
            h('button', { type: 'button', disabled: i === 0, 'aria-label': `Move up: ${name}`, onclick: act({ action: 'move', code: s.code, by: -1 }, `Moved up: ${name}`) }, 'Up'),
            h('button', { type: 'button', disabled: i === list.length - 1, 'aria-label': `Move down: ${name}`, onclick: act({ action: 'move', code: s.code, by: 1 }, `Moved down: ${name}`) }, 'Down'),
            h('button', { type: 'button', 'aria-label': `Remove: ${name}`, onclick: act({ action: 'remove', code: s.code }, `Removed ${name}`) }, 'Remove')));
        }
        return li;
      }));
    };
    editBtn.addEventListener('click', () => {
      editing = !editing;
      editBtn.setAttribute('aria-pressed', String(editing));
      editBtn.textContent = editing ? 'Done editing' : 'Edit list';
      draw();
    });
    draw();
    main.append(ul, h('p', null, editBtn));
  }

  // ------------------------------------------------------------ one stop
  async function stopView(code, at) {
    const h1 = view(`Stop ${code}`);
    const meta = h('p', { class: 'muted' });
    const updated = h('span', null, '');
    const refreshBtn = h('button', { type: 'button', class: 'primary' }, 'Refresh times');
    const autoBox = h('input', { type: 'checkbox', id: 'auto' });
    autoBox.checked = localStorage.getItem('auto') !== '0';
    const listHead = h('h2', { tabindex: '-1' }, at ? 'Buses' : 'Next buses');
    const list = h('ol', { class: 'list' });
    const note = h('p', { class: 'muted' });
    const msg = h('div');

    // Date and time to look ahead to.
    const nowParts = new Date();
    const dateIn = h('input', { type: 'date', id: 'when-date' });
    const timeIn = h('input', { type: 'time', id: 'when-time' });
    if (at) { const [d, t] = at.split('T'); dateIn.value = d; timeIn.value = t; }
    else {
      dateIn.value = dateKeyFmt.format(nowParts);
      timeIn.value = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nowParts);
    }
    const lookForm = h('form', null,
      h('label', { for: 'when-date' }, 'Date'), dateIn,
      h('label', { for: 'when-time' }, 'Time'), timeIn,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'primary' }, 'Show buses'),
        at ? h('button', { type: 'button', onclick: () => { location.hash = `#/stop/${encodeURIComponent(code)}`; } }, 'Back to now') : null));
    lookForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!dateIn.value || !timeIn.value) { announce('Pick a date and a time.'); return; }
      location.hash = `#/stop/${encodeURIComponent(code)}?at=${dateIn.value}T${timeIn.value}`;
    });
    const look = h('details', at ? { open: true } : null, h('summary', null, at ? 'Change date and time' : 'Look ahead to a date and time'), lookForm);

    const saveArea = h('div');
    let lastLoad = 0, busy = false;

    const tick = () => {
      if (!lastLoad) return;
      const s = Math.round((Date.now() - lastLoad) / 1000);
      updated.textContent = s < 10 ? 'Updated just now' : s < 60 ? `Updated ${s} seconds ago` : `Updated ${Math.floor(s / 60)} min ago`;
    };

    function drawSave(stop) {
      const nick = h('input', { type: 'text', id: 'nick', value: stop.nick || '', autocomplete: 'off' });
      const doSave = async (action, text) => {
        try { await api('/api/saved', { action, code, nick: nick.value }); stop.saved = action !== 'remove'; stop.nick = action === 'remove' ? '' : nick.value.trim(); drawSave(stop); setTitle(stop); announce(text); }
        catch (err) { announce(err.message); }
      };
      const form = h('form', null,
        h('label', { for: 'nick' }, stop.saved ? 'Nickname' : 'Nickname (optional)'), nick,
        h('div', { class: 'row' },
          h('button', { type: 'submit', class: stop.saved ? null : 'primary' }, stop.saved ? 'Rename' : 'Save stop'),
          stop.saved ? h('button', { type: 'button', onclick: () => doSave('remove', 'Removed from saved stops') }, 'Remove from saved') : null));
      form.addEventListener('submit', (e) => { e.preventDefault(); doSave(stop.saved ? 'rename' : 'add', stop.saved ? 'Renamed' : 'Saved'); });
      saveArea.replaceChildren(h('h2', null, stop.saved ? 'Saved stop' : 'Save this stop'), form);
    }

    function setTitle(stop) {
      const title = stop.nick ? `${stop.nick}: ${stop.label}` : stop.label;
      h1.textContent = title;
      document.title = `${title} - Bus times`;
    }

    async function load(manual) {
      if (busy) return;
      busy = true;
      refreshBtn.disabled = true;
      try {
        const d = await api(`/api/stop/${encodeURIComponent(code)}${at ? `?at=${encodeURIComponent(at)}` : ''}`);
        if (!lastLoad) { setTitle(d.stop); meta.textContent = stopLine(d.stop); drawSave(d.stop); }
        if (d.lookAhead) listHead.textContent = `Buses from ${longFmt.format(d.at)}`;
        const showMissing = !d.lookAhead || Math.abs(d.at - d.now) < 3 * 3600e3;
        list.replaceChildren(...(d.arrivals.length ? d.arrivals.map((a) => {
          let est;
          if (a.status === 'cancelled') est = h('span', { class: 'bad' }, 'Cancelled');
          else if (a.status === 'skipped') est = h('span', { class: 'bad' }, 'Stop skipped');
          else if (a.estimated != null) est = h('span', { class: 'est' }, `Estimated ${fmtTime(a.estimated, d.at)}`);
          else if (showMissing) est = h('span', { class: 'muted' }, 'No estimate');
          return h('li', { class: 'bus' },
            h('div', { class: 'title' }, `${a.route} ${a.headsign}`),
            h('div', { class: 'times' }, h('span', null, `Scheduled ${fmtTime(a.scheduled, d.at)}`), est));
        }) : [h('li', null, 'No buses found.')]));
        const notes = [];
        if (d.stop.label.endsWith('*')) notes.push('* The direction is a best guess.');
        if (d.liveError) notes.push(`Live estimates are not available right now (${d.liveError}).`);
        note.textContent = notes.join(' ');
        msg.replaceChildren();
        lastLoad = Date.now();
        tick();
        if (manual) announce('Times updated');
      } catch (err) {
        msg.replaceChildren(errorBox(err));
        if (manual) announce(err.message);
      } finally {
        busy = false;
        refreshBtn.disabled = false;
      }
    }

    refreshBtn.addEventListener('click', () => load(true));
    autoBox.addEventListener('change', () => localStorage.setItem('auto', autoBox.checked ? '1' : '0'));

    const status = h('div', { class: 'status' }, refreshBtn, updated);
    main.append(meta, status,
      at ? null : h('label', { class: 'check' }, autoBox, 'Refresh every 30 seconds'),
      look, msg, listHead, list, note, saveArea);

    timers.push(setInterval(tick, 5000));
    if (!at) timers.push(setInterval(() => {
      if (autoBox.checked && document.visibilityState === 'visible' && Date.now() - lastLoad >= 29000) load(false);
    }, 5000));
    await load(false);
  }

  // ------------------------------------------------------------ find a stop
  function findView() {
    view('Find a stop');
    const results = h('div');
    const show = (title, content) => {
      const h2 = h('h2', { tabindex: '-1' }, title);
      results.replaceChildren(h2, content);
      h2.focus();
    };
    const run = async (title, fn) => {
      results.replaceChildren(h('p', null, 'Searching…'));
      try { show(title, await fn()); } catch (err) { results.replaceChildren(errorBox(err)); }
    };

    const q1 = h('input', { type: 'search', id: 'q-stop', autocomplete: 'off', enterkeyhint: 'search' });
    const f1 = h('form', { role: 'search' }, h('label', { for: 'q-stop' }, 'Stop number or name'), h('div', { class: 'row' }, q1, h('button', { type: 'submit', class: 'primary' }, 'Search')));
    f1.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = q1.value.trim();
      if (!q) return;
      run('Stops', async () => {
        const found = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (/^\d+$/.test(q) && found.length === 1) { location.hash = `#/stop/${found[0].code}`; return h('p', null, 'Opening…'); }
        return stopList(found);
      });
    });

    const q2 = h('input', { type: 'search', id: 'q-place', autocomplete: 'off', enterkeyhint: 'search' });
    const f2 = h('form', { role: 'search' }, h('label', { for: 'q-place' }, 'Address or place'), h('div', { class: 'row' }, q2, h('button', { type: 'submit', class: 'primary' }, 'Search')));
    f2.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = q2.value.trim();
      if (!q) return;
      run('Places', async () => {
        const places = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (!places.length) return h('p', null, 'No places found in the Edmonton area.');
        return h('ul', { class: 'list' }, places.map((p) => h('li', null,
          h('button', { type: 'button', onclick: () => run(`Stops near ${p.name}`, async () => stopList(await api(`/api/near?lat=${p.lat}&lon=${p.lon}`))) }, p.name))));
      });
    });

    const nearBtn = h('button', { type: 'button', class: 'primary' }, 'Stops near me');
    nearBtn.addEventListener('click', () => {
      if (!navigator.geolocation) { results.replaceChildren(errorBox(new Error('This browser cannot share location.'))); return; }
      results.replaceChildren(h('p', null, 'Finding your location…'));
      navigator.geolocation.getCurrentPosition(
        (pos) => run('Stops near you', async () => stopList(await api(`/api/near?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`))),
        (err) => results.replaceChildren(errorBox(new Error(err.code === 1 ? 'Location permission was denied.' : 'Your location could not be found.'))),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });

    main.append(f1, f2, h('div', { class: 'row' }, nearBtn), results);
  }

  // ------------------------------------------------------------ route
  function routeView(initial) {
    view('Route');
    const results = h('div');
    const q = h('input', { type: 'search', id: 'q-route', autocomplete: 'off', inputmode: 'numeric', enterkeyhint: 'search', value: initial || '' });
    const form = h('form', { role: 'search' }, h('label', { for: 'q-route' }, 'Route number'), h('div', { class: 'row' }, q, h('button', { type: 'submit', class: 'primary' }, 'Show route')));
    const search = async (focus) => {
      const r = q.value.trim();
      if (!r) return;
      results.replaceChildren(h('p', null, 'Loading…'));
      try {
        const dirs = await api(`/api/route?q=${encodeURIComponent(r)}`);
        if (!dirs.length) { results.replaceChildren(h('p', null, `No bus route ${r} found.`)); return; }
        const stopsArea = h('div');
        const h2 = h('h2', { tabindex: '-1' }, `Route ${dirs[0].route}: pick a direction`);
        results.replaceChildren(h2, h('ul', { class: 'list' }, dirs.map((d) => h('li', null,
          h('button', { type: 'button', onclick: () => {
            const sh = h('h2', { tabindex: '-1' }, `${d.route} ${d.headsign}: ${d.stops.length} stops`);
            stopsArea.replaceChildren(sh, stopList(d.stops));
            sh.focus();
          } }, `${d.headsign} (${d.stops.length} stops)`)))), stopsArea);
        if (focus) h2.focus();
        history.replaceState(null, '', `#/route/${encodeURIComponent(r)}`);
      } catch (err) { results.replaceChildren(errorBox(err)); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); search(true); });
    main.append(form, results);
    if (initial) search(false);
  }

  // ------------------------------------------------------------ router
  function route() {
    const hash = decodeURIComponent(location.hash.slice(1) || '/');
    const [p, query] = hash.split('?');
    const parts = p.split('/').filter(Boolean);
    if (parts[0] === 'stop' && parts[1]) return stopView(parts[1], new URLSearchParams(query || '').get('at'));
    if (parts[0] === 'find') return findView();
    if (parts[0] === 'route') return routeView(parts[1]);
    return savedView();
  }
  window.addEventListener('hashchange', route);
  route();
})();
