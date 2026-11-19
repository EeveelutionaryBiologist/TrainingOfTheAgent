/*
 * bench/viewer_check.js — the replay viewer in a real browser (R22).
 *
 * Records a few episodes through the Env in Node (random policies; a test room, a boss fight, a full run with
 * transitions between rooms and floors), starts the viewer on them, opens the page in headless Chromium and checks:
 *   - every recording plays to its end and ends in the recorded state (the page's own verdict);
 *   - seeking backwards and forwards, single frames and decisions land on the right frame;
 *   - switching recordings by #t=<id>, and opening a local file through the file input;
 *   - no page errors, no horizontal scrolling at phone width.
 * Screenshots go to bench/results/ (git-ignored).
 *
 * Playwright is taken from the game checkout's node_modules, as in bench/browser_determinism.js.
 * Usage: node bench/viewer_check.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEnv, getGame } = require('../js/node/index.js');
const { createViewer } = require('../js/node/viewer.js');
const { mulberry32 } = require('../js/core/sim.js');

function record(dir) {
  const env = createEnv({ record: true, observe: 'none' });
  const scenarios = [
    { kind: 'test_room', seed: 'VC-BUG', enemies: ['bug'], maxPlayFrames: 2400 },
    { kind: 'test_room', seed: 'VC-BOSS', boss: 'monolith', player: { god: true, pushes: 5 }, endOn: ['boss_kill'], maxPlayFrames: 1800 },
    { kind: 'full_run', seed: 'VC-FULL', depth: 2, player: { god: true, pushes: 10 }, maxPlayFrames: 3000 },
  ];
  return scenarios.map((sc, n) => {
    const rnd = mulberry32(900 + n);
    let ep = env.reset(sc);
    while (!ep.done) ep = env.step(Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.04 ? 1 : 0, rnd() < 0.04 ? 1 : 0);
    const file = path.join(dir, `${String(n).padStart(2, '0')}-${sc.seed}.json`);
    fs.writeFileSync(file, JSON.stringify(env.transcript()));
    return file;
  });
}

(async () => {
  const game = getGame({});
  let playwright;
  try {
    playwright = require(path.join(game.source.gameDir, 'node_modules', 'playwright'));
  } catch (err) {
    console.log('SKIPPED: Playwright not found in the game checkout (run its tools/setup-dev.sh). ' + err.message);
    process.exit(2);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bota-viewer-check-'));
  const files = record(dir);
  const shots = path.join(__dirname, 'results');
  fs.mkdirSync(shots, { recursive: true });
  const viewer = createViewer({ paths: [dir] });
  await new Promise((resolve) => viewer.server.listen(0, '127.0.0.1', resolve));
  const U = `http://127.0.0.1:${viewer.server.address().port}/`;

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  const failures = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
  const frameNow = () => page.$eval('#pos', (el) => Number((/frame (\d+)/.exec(el.textContent) || [])[1]));
  const ready = () => page.waitForFunction(() => !document.getElementById('play').disabled && !/seeking/.test(document.getElementById('pos').textContent));
  const verdict = async () => {
    await page.waitForFunction(() => !document.getElementById('badge').hidden, null, { timeout: 120000 });
    return page.$eval('#badge', (el) => el.textContent);
  };
  const open = async (id) => { await page.goto('about:blank'); await page.goto(`${U}#t=${id}`); await ready(); };

  const info = await (await page.request.get(U + 'api/info')).json();
  check(info.transcripts.length === files.length, `the server lists the ${files.length} recordings`);
  for (const t of info.transcripts) {
    await open(t.id);
    const title = await page.$eval('#title', (el) => el.textContent);
    await page.selectOption('#speed', '32');
    await page.click('#play');
    const v = await verdict();
    check(title.includes(t.seed) && v.startsWith('✓') && (await frameNow()) === t.frames, `${t.name} (${t.kind}, ${t.reason}, ${t.frames} frames) plays to the end in the recorded state: ${v}`);
  }

  // seeking and stepping on the full run (it has floor cards and room transitions)
  const full = info.transcripts.find((t) => t.kind === 'full_run');
  await open(full.id);
  const seekTo = async (f) => { await page.fill('#seek', String(f)); await page.dispatchEvent('#seek', 'input'); await ready(); return frameNow(); };
  check((await seekTo(1800)) === 1800, 'seek forward lands on the frame');
  await page.screenshot({ path: path.join(shots, 'viewer.png') });
  check((await seekTo(300)) === 300, 'seek backwards (rebuild from the start) lands on the frame');
  await page.keyboard.press('Home'); await ready();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await ready();
  check((await frameNow()) === 5 + 2 * 4 - 1, 'frame and decision steps add up, however fast they are pressed');
  await page.keyboard.press('End');
  check((await verdict()).startsWith('✓'), 'after seeking around, the end still matches the recording');

  await page.evaluate((id) => { location.hash = `t=${id}`; }, info.transcripts[0].id);
  await page.waitForFunction((seed) => document.getElementById('title').textContent.includes(seed), info.transcripts[0].seed);
  check(await page.$eval('#badge', (el) => el.hidden), 'changing #t= on an open page switches recordings and clears the verdict');

  await page.goto(U);
  await page.setInputFiles('#file', files[1]);
  await ready();
  await page.selectOption('#speed', '32');
  await page.click('#play');
  check((await verdict()).startsWith('✓'), 'a local file opened in the page plays to the recorded end');

  await page.setViewportSize({ width: 390, height: 800 });
  await open(info.transcripts[0].id);
  await page.screenshot({ path: path.join(shots, 'viewer-phone.png') });
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scrolling at phone width');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);

  await browser.close();
  await new Promise((resolve) => viewer.server.close(resolve));
  console.log(failures.length ? `${failures.length} FAILED` : 'ALL OK');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
