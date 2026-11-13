/*
 * bench/test_room.js — Phase 0 check: does a constructed test room behave like a real room?
 *
 * Compares four ways of getting the player into a fight on floor 1:
 *   real-walk     walk through the door into an untouched combat room next to the start room
 *   real-call     same room, entered by calling game.changeRoom(dir) (what the door check itself calls)
 *   constructed   a neighbour room overwritten with our own layout and enemy list, entered via changeRoom(dir)
 *   debug-spawn   BOTA.debug.spawn(...) into the start room (the naive use of the debug hooks)
 *
 * For each it records: non-play frames on entry, doors closed during the fight, enemy spawn delay, whether the
 * room-clear event fires, doors reopening, score and active-item charge bookkeeping.
 *
 * Usage: node bench/test_room.js [--seeds 300]
 */
'use strict';

const { loadGame } = require('../js/node/loader.js');
const { Sim } = require('../js/core/sim.js');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const SEEDS = arg('seeds', 300);
const DIR_KEY = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' };

const game = loadGame({ profile: 'full' });
const inst = game.createInstance();
const B = inst.B;
const sim = new Sim(B, inst.host);

let clears = 0;
B.bus.on('roomClear', () => { clears++; });

function toPlay() { let n = 0; while (B.game.state !== 'play' && !sim.terminal && n < 2000) { sim.step(); n++; } return n; }

/** Doors of the start room that lead to an unvisited room of the wanted kind */
function neighbours(filter) {
  const start = B.game.floor.start.room;
  return Object.keys(start.doors).filter((dir) => {
    const d = start.doors[dir];
    return !d.edge.hidden && !d.edge.locked && filter(d.target.room);
  });
}

/** Fight bookkeeping from the moment the room is entered until it is cleared */
function observeFight(label, entryFrames) {
  const g = B.game, room = g.room;
  const out = { label, entryFrames, enemies: room.enemies.length, closedOnEntry: room.combatClosed, clearedOnEntry: room.cleared };
  out.spawnDelay = room.enemies.length ? Math.max(...room.enemies.map((e) => e.spawnDelay)) : 0;
  out.enemyPos = room.enemies.map((e) => `${e.id}@${e.x.toFixed(3)},${e.y.toFixed(3)}`).join(' ');
  // frames until every enemy is past its spawn delay (no action, no contact damage before that)
  let wake = 0;
  while (room.enemies.some((e) => e.spawnDelay > 0) && wake < 200) { sim.step(); wake++; }
  out.wakeFrames = wake;
  const before = { clears, rooms: g.score.rooms, kills: g.score.kills, pickups: room.pickups.length };
  B.debug.god(true);
  // Kill through the game's own death path; repeat because some enemies split or revive
  for (let f = 0; f < 60 && room.hasLivingEnemies(); f++) { B.debug.killAll(); sim.step(); }
  for (let i = 0; i < 5; i++) sim.step();
  out.clearEvent = clears - before.clears;
  out.scoreRooms = g.score.rooms - before.rooms;
  out.scoreKills = g.score.kills - before.kills;
  out.openAfter = !room.combatClosed;
  out.cleared = room.cleared;
  out.drops = room.pickups.length - before.pickups;
  return out;
}

function realRoom(seed, how) {
  sim.reset(seed);
  toPlay();
  const dirs = neighbours((r) => r.type === 'normal' && r.plannedEnemies.length > 0);
  if (!dirs.length) return null;
  const dir = dirs[0];
  const from = B.game.room;
  let entry = 0;
  if (how === 'walk') {
    // Walk to the door column/row first, then through the door
    const dt = B.C.DOOR_TILES[dir], target = from.tileCenter(dt.col, dt.row);
    const p = B.game.player;
    const horizontal = dir === 'left' || dir === 'right';
    let guard = 0;
    while (B.game.room === from && guard++ < 1200) {
      const off = horizontal ? target.y - p.y : target.x - p.x;
      const align = Math.abs(off) > 6;
      sim.key('KeyW', align && horizontal && off < 0); sim.key('KeyS', align && horizontal && off > 0);
      sim.key('KeyA', align && !horizontal && off < 0); sim.key('KeyD', align && !horizontal && off > 0);
      if (!align) sim.key(DIR_KEY[dir], true);
      sim.step();
    }
    sim.releaseAll();
    if (B.game.room === from) return { label: 'real-walk', failed: 'never reached the door' };
  } else {
    B.game.changeRoom(dir);
  }
  entry = toPlay();
  return Object.assign(observeFight(how === 'walk' ? 'real-walk' : 'real-call', entry), { dir });
}

function constructed(seed) {
  sim.reset(seed);
  toPlay();
  const dirs = neighbours((r) => r.type === 'normal');
  if (!dirs.length) return null;
  const dir = dirs[0];
  const room = B.game.room.doors[dir].target.room;
  const layout = B.LAYOUTS.find((l) => l.tags.includes('normal'));
  room.stampLayout(layout);
  room.plannedEnemies = ['bug', 'bug'];
  room.looseLoot = []; room.hasReadme = false; room.hasPipe = false; room.guaranteedKey = false; room.encounterBoss = null;
  room.props.clear();
  B.game.changeRoom(dir);
  return Object.assign(observeFight('constructed', toPlay()), { dir });
}

function debugSpawn(seed) {
  sim.reset(seed);
  toPlay();
  B.debug.spawn('bug', 300, 200); B.debug.spawn('bug', 660, 200);
  return observeFight('debug-spawn', 0);
}

const tally = {};
const add = (r) => {
  if (!r || r.failed) return;
  const t = tally[r.label] || (tally[r.label] = { n: 0, closedOnEntry: 0, spawnDelay05: 0, clearEvent: 0, scoreRooms: 0, openAfter: 0, cleared: 0, entryFrames: new Set(), wakeFrames: new Set(), drops: 0 });
  t.n++;
  if (r.closedOnEntry) t.closedOnEntry++;
  if (Math.abs(r.spawnDelay - 0.5) < 1e-9) t.spawnDelay05++;
  if (r.clearEvent === 1) t.clearEvent++;
  if (r.scoreRooms === 1) t.scoreRooms++;
  if (r.openAfter) t.openAfter++;
  if (r.cleared) t.cleared++;
  if (r.drops > 0) t.drops++;
  t.entryFrames.add(r.entryFrames); t.wakeFrames.add(r.wakeFrames);
};

let noCombatNeighbour = 0, noNormalNeighbour = 0, walkSame = 0, walkCompared = 0, walkFailed = 0;
for (let i = 0; i < SEEDS; i++) {
  const seed = `ROOM-${i}`;
  const call = realRoom(seed, 'call');
  if (!call) noCombatNeighbour++;
  add(call);
  const walk = realRoom(seed, 'walk');
  if (walk && walk.failed) walkFailed++;
  add(walk);
  if (call && walk && !walk.failed) { walkCompared++; if (call.enemyPos === walk.enemyPos && call.dir === walk.dir) walkSame++; }
  const con = constructed(seed);
  if (!con) noNormalNeighbour++;
  add(con);
  add(debugSpawn(seed));
}

console.log(`floor 1, ${SEEDS} seeds, game ${game.source.commit.slice(0, 7)}`);
console.log(`start room has no unlocked combat-room neighbour: ${noCombatNeighbour} seeds; no normal-room neighbour at all: ${noNormalNeighbour} seeds`);
console.log(`walking in vs calling changeRoom: identical enemy spawns in ${walkSame}/${walkCompared} seeds (walk failed: ${walkFailed})\n`);
const pct = (a, n) => `${a}/${n}`;
console.log('way in'.padEnd(13) + 'n'.padStart(5) + ' doorsClosed'.padStart(13) + ' spawnDelay.5'.padStart(14) + ' clearEvent'.padStart(12) + ' roomScore'.padStart(11) +
  ' doorsReopen'.padStart(13) + ' cleared'.padStart(9) + ' drops'.padStart(8) + '  entry frames / wake frames');
for (const label of ['real-walk', 'real-call', 'constructed', 'debug-spawn']) {
  const t = tally[label];
  if (!t) continue;
  console.log(label.padEnd(13) + String(t.n).padStart(5) + pct(t.closedOnEntry, t.n).padStart(13) + pct(t.spawnDelay05, t.n).padStart(14) + pct(t.clearEvent, t.n).padStart(12) +
    pct(t.scoreRooms, t.n).padStart(11) + pct(t.openAfter, t.n).padStart(13) + pct(t.cleared, t.n).padStart(9) + pct(t.drops, t.n).padStart(8) +
    `  ${[...t.entryFrames].sort((a, b) => a - b).join(',')} / ${[...t.wakeFrames].sort((a, b) => a - b).join(',')}`);
}
console.log(`console.warn/error lines from the game: ${inst.host.errors.length}`);
