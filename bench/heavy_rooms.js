/*
 * bench/heavy_rooms.js — Phase 0 check: step rate in the heaviest rooms.
 *
 * For every boss (floors 1 and 11) and for dense enemy mixes, a god-mode player with a random policy fights for a
 * fixed number of frames. Reports frames/s on one core, the peak projectile and enemy counts, and any fault.
 * Halfway through, boss HP is cut to 35 % so later phases run too.
 *
 * Usage: node bench/heavy_rooms.js [--frames 3600] [--profile full|lean]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadGame } = require('../js/node/loader.js');
const { Sim, randomPolicy, mulberry32 } = require('../js/core/sim.js');

const argv = process.argv;
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i > 0 ? argv[i + 1] : def; };
const FRAMES = Number(arg('frames', 3600));
const PROFILES = arg('profile', null) ? [arg('profile')] : ['full', 'lean'];

function fight(sim, setup, frames, timed) {
  const B = sim.B;
  const res = { fps: 0, maxProjectiles: 0, maxEnemies: 0, maxEffects: 0, fault: null, consoleErrors: 0 };
  const errs = sim.host.errors.length;
  try {
    sim.reset(setup.seed, { depth: setup.depth, god: true });
    while (B.game.state !== 'play') sim.step();
    setup.spawn(B);
    const act = randomPolicy(99);
    const t0 = process.hrtime.bigint();
    for (let f = 0; f < frames; f++) {
      const g = B.game;
      if (g.state === 'play' && f % 4 === 0) act(sim);
      if (f === (frames >> 1)) for (const e of g.room.enemies) if (e.isBoss) e.hp = Math.min(e.hp, e.maxHp * 0.35);
      sim.step();
      const r = B.game.room;
      if (r.projectiles.length > res.maxProjectiles) res.maxProjectiles = r.projectiles.length;
      if (r.enemies.length > res.maxEnemies) res.maxEnemies = r.enemies.length;
      if (r.effects.length > res.maxEffects) res.maxEffects = r.effects.length;
    }
    if (timed) res.fps = Math.round(frames / (Number(process.hrtime.bigint() - t0) / 1e9));
  } catch (err) {
    res.fault = String(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : err);
  }
  res.consoleErrors = sim.host.errors.length - errs;
  return res;
}

function cases(B) {
  const list = [];
  for (const depth of [1, 11]) {
    for (const id of Object.keys(B.BOSSES)) {
      list.push({ name: `boss ${id}`, depth, seed: `HEAVY-${id}-${depth}`, spawn: (b) => b.debug.spawnBoss(id) });
    }
  }
  // Dense mixes of regular enemies: everything the room generator can roll (has a spawn weight)
  const rollable = Object.keys(B.ENEMIES).filter((id) => B.ENEMIES[id].weight > 0 && B.ENEMIES[id].minFloor !== undefined);
  for (const n of [20, 40]) {
    list.push({
      name: `${n} mixed enemies`, depth: 11, seed: `HEAVY-mix-${n}`,
      spawn: (b) => {
        const r = mulberry32(n);
        for (let i = 0; i < n; i++) b.debug.spawn(rollable[Math.floor(r() * rollable.length)], 150 + r() * 660, 130 + r() * 320);
      },
    });
  }
  return list;
}

const rows = [];
for (const profile of PROFILES) {
  const game = loadGame({ profile });
  const inst = game.createInstance();
  const sim = new Sim(inst.B, inst.host);
  for (const c of cases(inst.B)) {
    fight(sim, c, 1200, false);            // warm-up for the JIT, untimed
    const res = fight(sim, c, FRAMES, true);
    rows.push(Object.assign({ profile, name: c.name, depth: c.depth }, res));
  }
}

for (const profile of PROFILES) {
  const mine = rows.filter((r) => r.profile === profile).sort((a, b) => a.fps - b.fps);
  console.log(`\n[${profile}] ${FRAMES} frames per case, one core. Slowest first.`);
  console.log('case'.padEnd(28) + 'floor'.padStart(6) + 'frames/s'.padStart(10) + 'maxProj'.padStart(9) + 'maxEnemies'.padStart(11) + 'maxFx'.padStart(7) + '  notes');
  for (const r of mine) {
    console.log(r.name.padEnd(28) + String(r.depth).padStart(6) + String(r.fps).padStart(10) + String(r.maxProjectiles).padStart(9) +
      String(r.maxEnemies).padStart(11) + String(r.maxEffects).padStart(7) + '  ' + (r.fault ? 'FAULT ' + r.fault.slice(0, 120) : r.consoleErrors ? r.consoleErrors + ' console errors' : ''));
  }
  const ok = mine.filter((r) => !r.fault);
  const fpsSorted = ok.map((r) => r.fps).sort((a, b) => a - b);
  console.log(`[${profile}] min ${fpsSorted[0]} | median ${fpsSorted[fpsSorted.length >> 1]} | max ${fpsSorted[fpsSorted.length - 1]} frames/s`);
}
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'heavy_rooms.json'), JSON.stringify(rows, null, 2));
