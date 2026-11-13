/*
 * bench/determinism.js — Phase 0 check: same seed and inputs give the same run.
 *
 * Runs a set of scripted episodes (random policy; half of them tour every room of floors 1..11 in god mode) and
 * compares their state signatures between:
 *   A  full profile, fresh instance per episode
 *   A' the same again
 *   R  full profile, ONE instance reused with in-instance reset
 *   L  lean profile (no audio.js / effects.js), fresh instance per episode
 *
 * Usage: node bench/determinism.js [--episodes 220] [--frames 6000]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadGame } = require('../js/node/loader.js');
const { Sim, runEpisode } = require('../js/core/sim.js');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const EPISODES = arg('episodes', 220);
const FRAMES = arg('frames', 6000);

function specs(n, frames) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tour = i % 2 === 1;
    out.push({ seed: `DET-${i}`, depth: 1 + (i % 11), god: tour, tourEvery: tour ? 300 : 0, frames });
  }
  return out;
}

function runSet(game, list, reuse) {
  let shared = null;
  const t0 = process.hrtime.bigint();
  const results = list.map((spec) => {
    // One Sim per instance: the Sim tracks which keys the game's input module currently holds
    const make = () => { const i = game.createInstance(); i.sim = new Sim(i.B, i.host); return i; };
    const inst = reuse ? shared || (shared = make()) : make();
    const before = inst.host.errors.length;
    const res = runEpisode(inst.sim, spec);
    res.consoleErrors = inst.host.errors.slice(before);
    if (res.fault && reuse) shared = null;
    return res;
  });
  return { results, seconds: Number(process.hrtime.bigint() - t0) / 1e9 };
}

function compare(name, a, b) {
  const diff = [];
  for (let i = 0; i < a.length; i++) if (a[i].sig !== b[i].sig || a[i].frames !== b[i].frames) diff.push(a[i].seed);
  console.log(`${name.padEnd(46)} ${diff.length === 0 ? 'IDENTICAL' : 'MISMATCH in ' + diff.length + ': ' + diff.slice(0, 8).join(', ')}`);
  return diff;
}

if (require.main === module) {
  const list = specs(EPISODES, FRAMES);
  const full = loadGame({ profile: 'full' });
  const lean = loadGame({ profile: 'lean' });
  console.log(`game ${full.source.commit.slice(0, 7)} pinned=${full.source.pinned} | ${EPISODES} episodes x up to ${FRAMES} frames`);

  const A = runSet(full, list, false);
  const A2 = runSet(full, list, false);
  const R = runSet(full, list, true);
  const L = runSet(lean, list, false);

  const frames = A.results.reduce((s, r) => s + r.frames, 0);
  const enemies = new Set(A.results.flatMap((r) => r.enemies));
  const bosses = [...enemies].filter((id) => full.createInstance().B.BOSSES[id]);
  const faults = A.results.filter((r) => r.fault);
  const consoleErrors = A.results.flatMap((r) => r.consoleErrors.map((e) => `${r.seed}@${e.frame}: ${e.text.slice(0, 160)}`));
  console.log(`frames simulated per set: ${frames} | deaths: ${A.results.filter((r) => r.endState === 'dead').length}` +
    ` | distinct enemy ids seen: ${enemies.size} (bosses: ${bosses.length})`);
  console.log(`exceptions: ${faults.length} | console.warn/error lines: ${consoleErrors.length}`);
  for (const f of faults.slice(0, 5)) console.log('  fault', f.seed, f.fault);
  for (const c of [...new Set(consoleErrors.map((c) => c.replace(/^[^:]*: /, '')))].slice(0, 5)) console.log('  console', c);
  console.log(`speed incl. reset: full fresh ${Math.round(frames / A.seconds)} f/s | full reused ${Math.round(frames / R.seconds)} f/s | lean fresh ${Math.round(frames / L.seconds)} f/s`);

  const d1 = compare('full, fresh instance, run twice', A.results, A2.results);
  const d2 = compare('full, in-instance reset vs fresh instance', A.results, R.results);
  const d3 = compare('lean vs full profile', A.results, L.results);

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'determinism.json'), JSON.stringify({
    commit: full.source.commit, episodes: EPISODES, frames: FRAMES, totalFrames: frames,
    enemyIds: [...enemies].sort(), bosses, faults: faults.length, consoleErrors: consoleErrors.length,
    mismatches: { twice: d1, reset: d2, lean: d3 },
  }, null, 2));
  process.exit(d1.length || d2.length || d3.length || faults.length ? 1 : 0);
}

module.exports = { specs };
