/*
 * bench/browser_determinism.js — Phase 0 check: the headless Node run matches the real game in a browser.
 *
 * Opens the game's own index.html in headless Chromium (Playwright), keeps its requestAnimationFrame loop from
 * running, injects js/core/sim.js and runs the same scripted episodes there, stepping game.update(DT) by hand.
 * Signatures are compared with the Node run of the same episodes.
 *
 * Second part (R22 groundwork): episodes recorded in Node through the real Env (scenario builder, frame-skip,
 * flow controller; lean profile) are replayed in the browser page from their transcripts with
 * js/core/recorder.js, and must end in the recorded state.
 *
 * Playwright is taken from the game checkout's node_modules (the game's own dev tooling, see its
 * tools/setup-dev.sh), so this repo needs no npm dependency for it.
 *
 * Both sides use js/core/detmath.js (the harness default). With --native-math both use the engine's own
 * sin/cos/exp/..., which is expected to differ between Node and Chromium.
 *
 * Usage: node bench/browser_determinism.js [--episodes 22] [--frames 4000] [--native-math]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadGame } = require('../js/node/loader.js');
const { Sim, runEpisode } = require('../js/core/sim.js');
const { specs } = require('./determinism.js');
const { createEnv } = require('../js/node/index.js');
const { mulberry32 } = require('../js/core/sim.js');

/** Episodes played through the Env in Node with a random policy; returns their transcripts */
function recordTranscripts(detMath) {
  // observe 'none': this check is about determinism and uses enemies the observation has not reviewed yet
  const env = createEnv({ record: true, detMath, observe: 'none' });
  const scenarios = [
    { kind: 'test_room', seed: 'BR-BUGS', enemies: [{ id: 'bug', count: 3 }, 'null_pointer'], player: { pushes: 5 }, maxPlayFrames: 2400 },
    { kind: 'test_room', seed: 'BR-DEATH', enemies: [{ id: 'null_pointer', count: 8 }], player: { health: 2 } },
    { kind: 'test_room', seed: 'BR-BOSS', boss: 'monolith', player: { god: true }, endOn: ['boss_kill'], maxPlayFrames: 3000 },
    { kind: 'test_room', seed: 'BR-ROCKS', layout: 'generated', enemies: ['memory_leak', 'bug', 'bug'], depth: 2, maxPlayFrames: 2400 },
    { kind: 'full_run', seed: 'BR-FULL5', depth: 5, maxPlayFrames: 4000 },
    { kind: 'full_run', seed: 'BR-FULL9', depth: 9, player: { god: true, pushes: 20 }, maxPlayFrames: 4000 },
  ];
  return scenarios.map((spec, n) => {
    const rnd = mulberry32(500 + n);
    let ep = env.reset(spec);
    while (!ep.done) ep = env.step(Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.05 ? 1 : 0, rnd() < 0.05 ? 1 : 0);
    return env.transcript();
  });
}

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const EPISODES = arg('episodes', 22);
const FRAMES = arg('frames', 4000);

const DETMATH = !process.argv.includes('--native-math');

(async () => {
  const game = loadGame({ profile: 'full', detMath: DETMATH });
  let playwright;
  try {
    playwright = require(path.join(game.source.gameDir, 'node_modules', 'playwright'));
  } catch (err) {
    console.log('SKIPPED: Playwright not found in the game checkout (run its tools/setup-dev.sh). ' + err.message);
    process.exit(2);
  }
  const list = specs(EPISODES, FRAMES);

  const nodeResults = list.map((spec) => {
    const inst = game.createInstance();
    return runEpisode(new Sim(inst.B, inst.host), spec);
  });

  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') pageErrors.push(msg.text()); });
  // The game's main.js starts its loop with requestAnimationFrame; make that a no-op so only we step the game.
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  if (DETMATH) {
    await page.addInitScript(fs.readFileSync(path.join(__dirname, '..', 'js', 'core', 'detmath.js'), 'utf8') + '\nBotaDetMath.install(Math);');
  }
  await page.goto(pathToFileURL(path.join(game.source.gameDir, 'index.html')).href);
  await page.evaluate(fs.readFileSync(path.join(__dirname, '..', 'js', 'core', 'sim.js'), 'utf8'));
  const version = await page.evaluate(() => navigator.userAgent);
  const browserResults = await page.evaluate((episodes) => {
    window.BOTA.audio.muted = true;
    const sim = new window.BotaSim.Sim(window.BOTA, null);
    return episodes.map((spec) => window.BotaSim.runEpisode(sim, spec));
  }, list);
  // Part 2: transcripts recorded through the Env in Node, replayed in the page
  const transcripts = recordTranscripts(DETMATH);
  for (const f of ['scenario.js', 'recorder.js']) await page.evaluate(fs.readFileSync(path.join(__dirname, '..', 'js', 'core', f), 'utf8'));
  const replays = await page.evaluate((list) => list.map((t) => {
    const r = window.BotaRecorder.replay({ B: window.BOTA, host: null }, t);
    return { ok: r.ok, signature: r.signature, frames: r.frames, state: r.sim.game.state };
  }), transcripts);
  await browser.close();

  let mismatches = 0, frames = 0;
  for (let i = 0; i < list.length; i++) {
    const a = nodeResults[i], b = browserResults[i];
    frames += a.frames;
    if (a.sig !== b.sig || a.frames !== b.frames || a.fault || b.fault) {
      mismatches++;
      console.log(`MISMATCH ${list[i].seed}: node ${a.sig} (${a.frames} frames, ${a.endState}) vs browser ${b.sig} (${b.frames} frames, ${b.endState}) ${a.fault || ''} ${b.fault || ''}`);
    }
  }
  const enemies = new Set(nodeResults.flatMap((r) => r.enemies));
  console.log(`Node ${process.version} (V8 ${process.versions.v8}) vs ${version}`);
  console.log(`math: ${DETMATH ? 'detmath.js on both sides' : 'native Math on both sides'}`);
  console.log(`${list.length} episodes, ${frames} frames, ${enemies.size} distinct enemy ids: ${mismatches === 0 ? 'IDENTICAL' : mismatches + ' MISMATCHES'}`);
  let replayBad = 0, replayFrames = 0;
  transcripts.forEach((t, i) => {
    replayFrames += t.endFrame;
    if (!replays[i].ok) {
      replayBad++;
      console.log(`REPLAY MISMATCH ${t.scenario.seed}: recorded ${t.signature} (${t.result.reason}), browser ${replays[i].signature} (${replays[i].state})`);
    }
  });
  console.log(`${transcripts.length} Env episodes recorded in Node (${transcripts.map((t) => t.result.reason).join(', ')}), ${replayFrames} frames, replayed in the browser: ${replayBad === 0 ? 'IDENTICAL' : replayBad + ' MISMATCHES'}`);
  mismatches += replayBad;
  if (pageErrors.length) console.log(`page errors/warnings: ${pageErrors.length}; first: ${pageErrors[0].slice(0, 200)}`);
  process.exit(mismatches ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
