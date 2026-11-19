/*
 * The replay viewer: the frame-by-frame Replayer it uses, and its local web server (endpoints, allowlists,
 * listing). The page itself runs in a browser: bench/viewer_check.js drives it in headless Chromium.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEnv, getGame, Recorder, Sim } = require('../node/index.js');
const { createViewer, HARNESS_FILES, VIEWER_FILES } = require('../node/viewer.js');
const { run } = require('./helpers.js');

/** A recorded episode under a seeded random policy, Force Push taps included */
function recordEpisode(seed) {
  const env = createEnv({ record: true });
  env.reset({ kind: 'test_room', seed, enemies: ['bug', 'bug'], endOn: [], player: { god: true, pushes: 9 }, maxPlayFrames: 1200 });
  const rnd = Sim.mulberry32(7);
  run(env, () => [Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.05 ? 1 : 0, 0], 1000);
  return env.transcript();
}

test('Replayer: stepping frame by frame ends where replay() ends, and tracks the keys the recording holds', () => {
  const t = recordEpisode('VIEW-1');
  assert.ok(t.keys.length > 30, 'a recording with key events');
  const game = getGame({ profile: t.meta.profile, detMath: t.meta.detMath });
  const whole = Recorder.replay(game.createInstance(), t);
  assert.equal(whole.ok, true);

  const r = new Recorder.Replayer(game.createInstance(), t);
  assert.equal(r.frame, 0);
  assert.equal(r.endFrame, t.endFrame);
  let sawHeld = false, sawTap = false;
  // expected held set from the transcript itself, frame by frame
  const held = new Set();
  let k = 0;
  while (!r.done) {
    while (k < t.keys.length && t.keys[k] === r.frame) {
      const code = t.codes[t.keys[k + 1]];
      if (t.keys[k + 2] === 1) held.add(code); else held.delete(code);
      k += 3;
    }
    assert.equal(r.step(), true);
    assert.deepEqual([...r.held].sort(), [...held].sort(), `held keys at frame ${r.frame}`);
    if (r.held.size) sawHeld = true;
    if (r.held.has('KeyE')) sawTap = true;
  }
  assert.equal(r.step(), false, 'nothing after the end');
  assert.ok(sawHeld && sawTap, 'movement keys and the Force Push tap were seen');
  const res = r.finish();
  assert.deepEqual([res.ok, res.signature, res.frames], [true, whole.signature, t.endFrame]);
  assert.equal(r.held.size, 0);
});

async function withViewer(paths, fn) {
  const v = createViewer({ paths });
  await new Promise((resolve) => v.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${v.server.address().port}`;
  try { await fn(base, v); } finally { await new Promise((resolve) => v.server.close(resolve)); }
}

test('viewer server: page, listing, transcripts, and nothing outside its allowlists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bota-viewer-'));
  const t = recordEpisode('VIEW-2');
  fs.writeFileSync(path.join(dir, 'b_episode.json'), JSON.stringify(t));
  fs.writeFileSync(path.join(dir, 'a_not_a_transcript.json'), JSON.stringify({ hello: 1 }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  await withViewer([dir], async (base, v) => {
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };

    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    const scripts = [...page.text.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts.slice(0, 3), ['/harness/detmath.js', '/harness/sim.js', '/viewer/boot.js'], 'math, clock and randomness are set up before the game loads');
    assert.deepEqual(scripts.slice(-3), ['/harness/scenario.js', '/harness/recorder.js', '/viewer/viewer.js']);
    assert.ok(!scripts.includes('/game/src/main.js'), 'the game loop is never started');
    for (const s of scripts) assert.equal((await get(s)).status, 200, s);

    const info = JSON.parse((await get('/api/info')).text);
    assert.equal(info.game.commit, v.source.commit);
    assert.equal(info.transcripts.length, 1, 'only real transcripts are listed');
    const item = info.transcripts[0];
    assert.deepEqual([item.id, item.name, item.seed, item.kind, item.reason, item.frames], [0, 'b_episode.json', 'VIEW-2', 'test_room', t.result.reason, t.endFrame]);
    assert.deepEqual(JSON.parse((await get('/api/transcripts/0')).text), t);

    // a recording added while the server runs shows up
    fs.writeFileSync(path.join(dir, 'c_later.json'), JSON.stringify(t));
    assert.equal(JSON.parse((await get('/api/info')).text).transcripts.length, 2);

    for (const p of ['/api/transcripts/7', '/api/transcripts/0x0', '/api/transcripts/-1', '/game/src/main.js', '/game/index.html',
      '/game/../package.json', '/game/%2e%2e/package.json', '/harness/loader.js', '/harness/../node/loader.js', '/viewer/../node/viewer.js',
      '/package.json', '/%E0%A4%A']) {
      const r = await get(p);
      assert.ok(r.status === 404 || r.status === 400, `${p} is refused (got ${r.status})`);
    }
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    assert.equal((await get('/')).status, 200, 'still serving after bad requests');
  });
  assert.deepEqual(HARNESS_FILES, ['detmath.js', 'sim.js', 'scenario.js', 'recorder.js']);
  for (const f of VIEWER_FILES) assert.ok(fs.existsSync(path.join(__dirname, '..', 'viewer', f)), f);
});
