/*
 * viewer.js — the replay page: load a transcript, replay it frame by frame with js/core/recorder.js, draw every
 * frame with the game's own renderer. Loaded last, after the game, scenario.js and recorder.js.
 */
(function () {
  'use strict';
  const B = window.BOTA, host = window.BotaViewerHost, Recorder = window.BotaRecorder;
  const W = B.C.W, H = B.C.H, FPS = 60;
  const $ = (id) => document.getElementById(id);
  const ui = {
    pick: $('pick'), file: $('file'), title: $('title'), badge: $('badge'), canvas: $('game'), drop: $('drop'),
    stage: $('stage'), restart: $('restart'), back: $('back'), play: $('play'), frame: $('frame'), decision: $('decision'),
    speed: $('speed'), clock: $('clock'), keys: $('keys'), seek: $('seek'), pos: $('pos'), state: $('state'),
    note: $('note'), meta: $('meta'),
  };
  const ctx = ui.canvas.getContext('2d');

  // What main.js would do, minus keyboard and the frame loop. Nothing the replay does is persisted.
  B.storage.save = function () {};
  B.audio.muted = true;
  B.game = new B.Game();

  let info = null;          // /api/info
  let T = null;             // the transcript
  let label = '';
  let rp = null;            // Recorder.Replayer
  let verdict = null;       // result of rp.finish() once the end is reached
  let playing = false;
  let speed = 1;
  let target = null;        // frame being sought, or null
  let acc = 0, last = null;
  const tapSeen = new Map(); // key code → frame it was last pressed (taps last one frame; shown a little longer)

  const KEYS = [
    ['KeyW', 'W'], ['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'],
    ['ArrowUp', '↑'], ['ArrowLeft', '←'], ['ArrowDown', '↓'], ['ArrowRight', '→'],
    ['KeyE', 'E'], ['Space', '␣'],
  ];
  const TAPS = new Set(['KeyE', 'Space']);
  ui.keys.innerHTML = KEYS.map(([code, text], i) => `${i === 4 || i === 8 ? '<i></i>' : ''}<kbd data-code="${code}" title="${code}">${text}</kbd>`).join('');
  const keyEls = new Map([...ui.keys.querySelectorAll('kbd')].map((el) => [el.dataset.code, el]));

  // ---- loading --------------------------------------------------------------------------------------------
  function note(text, kind) { ui.note.textContent = text || ''; ui.note.className = kind || ''; }

  function needsReload(t) {
    const want = t.meta && t.meta.detMath !== undefined ? !!t.meta.detMath : true;
    return want !== host.detMath ? want : null;
  }

  function reloadWithMath(detMath, hash) {
    const url = new URL(location.href);
    if (detMath) url.searchParams.delete('math'); else url.searchParams.set('math', 'native');
    url.hash = hash;
    location.replace(url.href);   // the query changes, so this loads the page anew
  }

  function load(t, name, source) {
    try { Recorder.validate(t); } catch (err) { note(`Not a transcript: ${err.message}`, 'bad'); return; }
    const math = needsReload(t);
    if (math !== null) {
      // The math layer is chosen before the game loads, so a recording made with the other setting needs a reload
      if (source && source.id !== undefined) return reloadWithMath(math, `t=${source.id}`);
      try { sessionStorage.setItem('bota.viewer.pending', JSON.stringify({ name, t })); } catch (e) {
        note('This recording was made with a different math setting and is too large to carry over a reload; reopen it after reloading with ' + (math ? 'no ?math parameter' : '?math=native'), 'bad');
        return;
      }
      return reloadWithMath(math, 'local');
    }
    T = t; label = name;
    target = null;
    ui.badge.hidden = true;
    ui.drop.hidden = true;
    ui.seek.max = String(T.endFrame);
    const sc = T.scenario, r = T.result || {};
    ui.title.textContent = `${name} · ${sc.kind} · seed ${sc.seed} · ${r.reason || '?'} after ${r.decisions ?? '?'} decisions`;
    ui.meta.textContent = JSON.stringify({ meta: T.meta, scenario: T.scenario, result: T.result, frameSkip: T.frameSkip,
      startFrame: T.startFrame, endFrame: T.endFrame, keyEvents: T.keys.length / 3, tampered: T.tampered, signature: T.signature }, null, 2);
    const warn = [];
    if (T.tampered) warn.push('control calls changed this episode, so the replay will not match it');
    if (T.meta && T.meta.game && info && T.meta.game.commit !== info.game.commit) warn.push(`recorded on game ${String(T.meta.game.commit).slice(0, 7)}, viewing on ${info.game.commit.slice(0, 7)}`);
    if (info && !info.game.pinned) warn.push('the game checkout is not the pinned version');
    note(warn.join('; '), warn.length ? 'warn' : '');
    rebuild();
    playing = false;
    render();
  }

  function rebuild() {
    if (rp) rp.sim.releaseAll();
    rp = new Recorder.Replayer({ B, host }, T);
    verdict = null;
    tapSeen.clear();
    acc = 0;
  }

  async function fetchInfo() {
    try {
      const res = await fetch('/api/info');
      info = await res.json();
    } catch (e) { info = null; return; }
    const keep = ui.pick.value;
    ui.pick.length = 1;
    for (const t of info.transcripts) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = `${t.name} — ${t.kind}, ${t.reason || '?'}, ${t.decisions ?? '?'} decisions${t.tampered ? ', tampered' : ''}`;
      ui.pick.appendChild(o);
    }
    ui.pick.value = keep;
  }

  async function loadById(id) {
    try {
      const res = await fetch(`/api/transcripts/${id}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const t = await res.json();
      const s = info && info.transcripts.find((x) => String(x.id) === String(id));
      ui.pick.value = String(id);
      history.replaceState(null, '', `#t=${id}`);
      load(t, s ? s.name : `#${id}`, { id });
    } catch (err) { note(`Could not load recording ${id}: ${err.message}`, 'bad'); }
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let t;
      try { t = JSON.parse(reader.result); } catch (err) { note(`${file.name} is not JSON: ${err.message}`, 'bad'); return; }
      ui.pick.value = '';
      history.replaceState(null, '', location.pathname + location.search);
      load(t, file.name, null);
    };
    reader.readAsText(file);
  }

  // ---- stepping -------------------------------------------------------------------------------------------
  /** Step up to n frames within a time budget (ms). Returns frames stepped. */
  function advance(n, budget) {
    if (!rp) return 0;
    const t0 = host.realNow();
    let done = 0;
    while (done < n && !rp.done) {
      rp.step();
      done++;
      for (const code of rp.held) if (TAPS.has(code)) tapSeen.set(code, rp.frame);
      if ((done & 63) === 0 && host.realNow() - t0 > budget) break;
    }
    if (rp.done && !verdict) finish();
    return done;
  }

  function finish() {
    verdict = rp.finish();
    playing = false;
    ui.badge.hidden = false;
    ui.badge.textContent = verdict.ok ? '✓ ended in the recorded state' : '✗ differs from the recording';
    ui.badge.className = 'badge ' + (verdict.ok ? 'ok' : 'bad');
    ui.badge.title = `recorded ${verdict.expected}\nreplayed ${verdict.signature}`;
  }

  /** The frame stepping is heading for: the pending seek target, else where the replay is */
  const cur = () => (target === null ? rp.frame : target);

  function seek(frame) {
    if (!rp) return;
    const f = Math.max(0, Math.min(T.endFrame, Math.round(frame)));
    if (f < rp.frame || verdict) { rebuild(); ui.badge.hidden = true; }
    target = f;
  }

  function togglePlay() {
    if (!rp) return;
    if (!playing && (rp.done || verdict)) { seek(0); }
    playing = !playing;
    acc = 0;
  }

  // ---- drawing --------------------------------------------------------------------------------------------
  function fit() {
    const pad = 16;   // main#stage padding, both sides
    const s = Math.max(0.1, Math.min((ui.stage.clientWidth - pad) / W, (ui.stage.clientHeight - pad) / H));
    const dpr = window.devicePixelRatio || 1;
    ui.canvas.style.width = Math.floor(W * s) + 'px';
    ui.canvas.style.height = Math.floor(H * s) + 'px';
    ui.canvas.width = Math.round(W * s * dpr);
    ui.canvas.height = Math.round(H * s * dpr);
    B.renderScale = ui.canvas.width / W;
    render();
  }

  function render() {
    if (!rp) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0d0b0a'; ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height); return; }
    try { B.Renderer.frame(ctx, B.game); } catch (err) { note(`render failed: ${err.message}`, 'bad'); }
  }

  const fmt = (frames) => {
    const s = frames / FPS, m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
  };

  function updateUi() {
    const has = !!rp;
    for (const el of [ui.restart, ui.back, ui.play, ui.frame, ui.decision, ui.seek]) el.disabled = !has;
    if (!has) return;
    const f = rp.frame, g = B.game;
    ui.play.textContent = playing ? '⏸\uFE0E' : '▶\uFE0E';   // text glyphs, not colour emoji
    if (document.activeElement !== ui.seek) ui.seek.value = String(target === null ? f : target);
    ui.clock.textContent = `${fmt(f)} / ${fmt(T.endFrame)}`;
    const agent = f < T.startFrame ? `setup, agent from frame ${T.startFrame}` : `agent playing since frame ${T.startFrame}`;
    ui.pos.textContent = `frame ${f} / ${T.endFrame} · ${agent}${target !== null ? ' · seeking…' : ''}`;
    ui.state.textContent = g ? `state ${g.state} · floor ${g.depth}${g.player ? ` · health ${g.player.health}/${g.player.maxHealth}` : ''}` : '';
    for (const [code, el] of keyEls) {
      const tapped = TAPS.has(code) && tapSeen.has(code) && f - tapSeen.get(code) < 12;
      el.classList.toggle('on', rp.held.has(code) || tapped);
    }
  }

  function tick(ts) {
    const dt = last === null ? 0 : Math.min(0.1, (ts - last) / 1000);
    last = ts;
    if (rp) {
      let stepped = 0;
      if (target !== null) {
        stepped = advance(target - rp.frame, 12);
        if (rp.frame >= target || rp.done) target = null;
      } else if (playing && !rp.done) {
        acc += dt * speed * FPS;
        const n = Math.floor(acc);
        acc -= n;
        stepped = advance(n, 12);
      }
      if (stepped || target === null) render();
    }
    updateUi();
    requestAnimationFrame(tick);
  }

  // ---- controls -------------------------------------------------------------------------------------------
  const frameSkip = () => (T && T.frameSkip) || 4;
  ui.pick.addEventListener('change', () => { if (ui.pick.value !== '') loadById(ui.pick.value); });
  setInterval(() => { if (document.activeElement !== ui.pick) fetchInfo(); }, 5000);   // new recordings in watched folders
  ui.file.addEventListener('change', () => { if (ui.file.files[0]) loadFile(ui.file.files[0]); ui.file.value = ''; });
  ui.restart.addEventListener('click', () => { playing = false; seek(0); });
  ui.back.addEventListener('click', () => { playing = false; seek(cur() - frameSkip()); });
  ui.play.addEventListener('click', togglePlay);
  ui.frame.addEventListener('click', () => { playing = false; seek(cur() + 1); });
  ui.decision.addEventListener('click', () => { playing = false; seek(cur() + frameSkip()); });
  ui.speed.addEventListener('change', () => { speed = Number(ui.speed.value); });
  ui.seek.addEventListener('input', () => seek(Number(ui.seek.value)));
  const speeds = [...ui.speed.options].map((o) => o.value);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (!rp) return;
    const k = e.key;
    if (k === ' ') togglePlay();
    else if (k === 'ArrowRight') { playing = false; seek(cur() + (e.shiftKey ? frameSkip() : 1)); }
    else if (k === 'ArrowLeft') { playing = false; seek(cur() - (e.shiftKey ? frameSkip() : 1)); }
    else if (k === 'Home') { playing = false; seek(0); }
    else if (k === 'End') { playing = false; seek(T.endFrame); }
    else if (k === '[' || k === ']') {
      const i = Math.max(0, Math.min(speeds.length - 1, speeds.indexOf(ui.speed.value) + (k === ']' ? 1 : -1)));
      ui.speed.value = speeds[i]; speed = Number(speeds[i]);
    } else return;
    e.preventDefault();
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  new ResizeObserver(fit).observe(ui.stage);

  // ---- start ----------------------------------------------------------------------------------------------
  // #t=<id> links to a recording of the server's list; changing it on an open page switches recordings
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (h.startsWith('t=') && h.slice(2) !== ui.pick.value) loadById(h.slice(2));
  });
  (async () => {
    await fetchInfo();
    const hash = location.hash.slice(1);
    if (hash.startsWith('t=')) loadById(hash.slice(2));
    else if (hash === 'local') {
      let pending = null;
      try { pending = JSON.parse(sessionStorage.getItem('bota.viewer.pending')); sessionStorage.removeItem('bota.viewer.pending'); } catch (e) { /* none */ }
      if (pending) load(pending.t, pending.name, null);
    } else if (info && info.transcripts.length === 1) loadById(info.transcripts[0].id);
    fit();
    requestAnimationFrame(tick);
  })();
})();
