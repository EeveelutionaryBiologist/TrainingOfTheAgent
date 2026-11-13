/*
 * bench/instances.js — Phase 0 check: memory per game instance, instances per process, scaling across cores.
 *
 * Child mode  (--child K): creates K instances in this process, warms each up, then steps them round-robin
 *                          (4 frames per turn, random policy, reset on death) for a fixed time and prints JSON.
 * Parent mode (default):   runs children for K = 1, 4, 16, 64 one at a time, then P parallel processes at K = 1
 *                          and K = 8 to see how throughput scales across cores.
 *
 * Usage: node bench/instances.js [--secs 4] [--profile full|lean] [--shared-code]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv;
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i > 0 ? argv[i + 1] : def; };
const SECS = Number(arg('secs', 4));
const PROFILE = arg('profile', 'lean');
const SHARED = argv.includes('--shared-code');   // one compiled copy for all instances (slower, for comparison)
const WARM_FRAMES = 12000;   // per instance, before measuring

function child(K) {
  const { loadGame } = require('../js/node/loader.js');
  const { Sim, randomPolicy } = require('../js/core/sim.js');
  const rss0 = process.memoryUsage().rss;
  const game = loadGame({ profile: PROFILE, sharedCode: SHARED });
  const rssLoaded = process.memoryUsage().rss;
  const sims = [];
  for (let i = 0; i < K; i++) {
    const inst = game.createInstance();
    const sim = new Sim(inst.B, inst.host);
    sim.episodes = 0; sim.act = randomPolicy(1000 + i); sim.id = i;
    sim.reset(`INST-${i}-0`);
    sims.push(sim);
  }
  const turn = (sim) => {
    if (sim.terminal) sim.reset(`INST-${sim.id}-${++sim.episodes}`);
    if (sim.state === 'play') sim.act(sim);
    for (let f = 0; f < 4; f++) sim.step();
  };
  for (let n = 0; n < WARM_FRAMES / 4; n++) for (const sim of sims) turn(sim);
  if (global.gc) global.gc();
  let frames = 0;
  const t0 = process.hrtime.bigint();
  const end = t0 + BigInt(Math.round(SECS * 1e9));
  while (process.hrtime.bigint() < end) {
    for (let n = 0; n < 50; n++) for (const sim of sims) { turn(sim); frames += 4; }
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const mem = process.memoryUsage();
  const faults = sims.reduce((s, sim) => s + sim.host.errors.length, 0);
  process.stdout.write(JSON.stringify({
    K, fps: Math.round(frames / secs), rssMB: +(mem.rss / 1048576).toFixed(1), heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    baseRssMB: +(rss0 / 1048576).toFixed(1), loadedRssMB: +(rssLoaded / 1048576).toFixed(1),
    episodes: sims.reduce((s, sim) => s + sim.episodes, 0), consoleErrors: faults,
  }) + '\n');
}

function runChild(K) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--expose-gc', __filename, '--child', String(K), '--secs', String(SECS), '--profile', PROFILE].concat(SHARED ? ['--shared-code'] : []), { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child K=${K} exited ${code}`))));
  });
}

async function parent() {
  const report = { profile: PROFILE, secs: SECS, single: [], parallel: [] };
  console.log(`[${PROFILE}${SHARED ? ', shared code' : ', code compiled per instance'}] one process, K instances stepped round-robin (after ${WARM_FRAMES} warm-up frames per instance)`);
  console.log('K'.padStart(4) + 'frames/s'.padStart(11) + 'RSS MB'.padStart(9) + 'heap MB'.padStart(9) + 'RSS MB/inst'.padStart(13));
  let base = null;
  for (const K of [1, 4, 16, 64]) {
    const r = await runChild(K);
    if (K === 1) base = r;
    const perInst = K === 1 ? '-' : ((r.rssMB - base.rssMB) / (K - 1)).toFixed(2);
    console.log(String(K).padStart(4) + String(r.fps).padStart(11) + String(r.rssMB).padStart(9) + String(r.heapMB).padStart(9) + String(perInst).padStart(13));
    report.single.push(r);
  }
  console.log(`process baseline: ${base.baseRssMB} MB RSS before loading, ${base.loadedRssMB} MB after compiling the game`);

  console.log(`\n[${PROFILE}] P processes in parallel`);
  console.log('P'.padStart(4) + 'K'.padStart(4) + 'total frames/s'.padStart(16) + 'per process'.padStart(13) + 'total RSS MB'.padStart(14));
  for (const [P, K] of [[1, 1], [8, 1], [16, 1], [32, 1], [16, 8]]) {
    const rs = await Promise.all(Array.from({ length: P }, () => runChild(K)));
    const total = rs.reduce((s, r) => s + r.fps, 0);
    const rss = rs.reduce((s, r) => s + r.rssMB, 0);
    console.log(String(P).padStart(4) + String(K).padStart(4) + String(total).padStart(16) + String(Math.round(total / P)).padStart(13) + rss.toFixed(0).padStart(14));
    report.parallel.push({ P, K, totalFps: total, totalRssMB: +rss.toFixed(1) });
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', `instances-${PROFILE}.json`), JSON.stringify(report, null, 2));
}

if (argv.includes('--child')) child(Number(arg('child', 1)));
else parent().catch((err) => { console.error(err); process.exit(1); });
