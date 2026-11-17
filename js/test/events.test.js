'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, Events, Probe, Control } = require('../node/index.js');
const { hunt } = require('./helpers.js');

const at = (name) => Events.NAMES.indexOf(name);
const ROOM = { kind: 'test_room', seed: 'E-ROOM-1', enemies: ['bug', 'bug'], maxPlayFrames: 3600 };

test('event counters hold the events of the last decision and add up over an episode', () => {
  const env = createEnv();
  let ep = env.reset(ROOM);
  assert.deepEqual(env.events.toObject(), {}, 'setup (entering the room) is not counted');
  const total = new Float32Array(Events.NAMES.length);
  const policy = () => hunt(env.B);
  let perDecisionMax = 0;
  while (!ep.done) {
    const a = policy();
    ep = env.step(a[0], a[1], a[2] || 0, a[3] || 0);
    for (let i = 0; i < total.length; i++) total[i] += env.events.counts[i];
    perDecisionMax = Math.max(perDecisionMax, env.events.counts[at('shots')]);
  }
  assert.equal(ep.reason, 'room_clear');
  assert.equal(total[at('kills')], 2);
  assert.equal(total[at('rooms_cleared')], 1);
  assert.equal(total[at('boss_kills')], 0);
  assert.equal(total[at('deaths')], 0);
  assert.equal(total[at('damage_dealt')] >= 16, true, 'two Bugs with 8 hit points each');
  assert.equal(total[at('hits_dealt')] >= 2, true);
  assert.equal(total[at('shots')] >= total[at('hits_dealt')], true);
  assert.ok(perDecisionMax <= 2, 'a decision of 4 frames cannot hold a whole episode of shots');
  assert.equal(env.game.runStats.kills, 2, 'agrees with the game\'s own count');
});

test('damage, death and items given during setup', () => {
  const env = createEnv();
  const itemId = Object.keys(env.gameSource.createInstance().B.ITEMS)[0];
  let ep = env.reset({ kind: 'test_room', seed: 'E-DEATH-1', enemies: [{ id: 'null_pointer', count: 8 }], player: { health: 2, items: [itemId] } });
  assert.equal(env.events.counts[at('items')], 0, 'the scenario\'s items are not the agent\'s pickups');
  let damage = 0, hits = 0, deaths = 0;
  for (let i = 0; i < 3000 && !ep.done; i++) {
    ep = env.step(0, 0, 0, 0);
    damage += env.events.counts[at('damage_taken')];
    hits += env.events.counts[at('hits_taken')];
    deaths += env.events.counts[at('deaths')];
  }
  assert.equal(ep.reason, 'death');
  assert.equal(deaths, 1);
  assert.ok(hits >= 1 && damage >= 2, `two half hearts were lost (damage ${damage}, hits ${hits})`);
});

test('pushes and refused actions are counted', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'E-PUSH-1', player: { pushes: 1, god: true } });
  env.step(0, 0, 1, 0);
  assert.equal(env.events.counts[at('pushes')], 1);
  env.step(0, 0, 1, 0);
  assert.equal(env.events.counts[at('pushes')], 0);
  assert.equal(env.events.counts[at('denied')], 1, 'no pushes left');
  env.step(0, 0, 0, 0);
  assert.deepEqual(env.events.toObject(), {});
});

test('event counters survive a replaced instance', () => {
  const env = createEnv({ record: true });
  env.reset(ROOM);
  env.game.room.update = () => { throw new Error('boom'); };
  assert.equal(env.step(0, 0, 0, 0).reason, 'fault');
  let ep = env.reset(ROOM);
  let kills = 0;
  const policy = () => hunt(env.B);
  while (!ep.done) { const a = policy(); ep = env.step(a[0], a[1], 0, 0); kills += env.events.counts[at('kills')]; }
  assert.equal(kills, 2, 'the new instance has its own counter');
});

test('probe: vector and snapshot agree with the game', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'E-PROBE-1', enemies: ['bug', 'bug', 'null_pointer'], player: { health: 5, maxHealth: 8, credits: 7, pushes: 3 } });
  const vec = new Float32Array(Probe.NAMES.length + 2).fill(-99);
  Probe.write(env.B, vec, 1);
  assert.equal(vec[0], -99);
  assert.equal(vec[vec.length - 1], -99, 'writes exactly its own fields');
  const p = (name) => vec[1 + Probe.NAMES.indexOf(name)];
  const g = env.game;
  assert.equal(p('health'), 5);
  assert.equal(p('max_health'), 8);
  assert.equal(p('credits'), 7);
  assert.equal(p('pushes'), 3);
  assert.equal(p('depth'), 1);
  assert.equal(p('enemies_alive'), 3);
  assert.equal(p('enemy_hp'), g.room.enemies.reduce((n, e) => n + e.hp, 0));
  assert.equal(p('room_type'), Probe.ROOM_TYPES.indexOf('normal'));
  assert.equal(p('room_cleared'), 0);
  assert.equal(p('doors_closed'), 1);
  assert.equal(p('boss_hp'), 0);
  assert.equal(p('active_charge'), -1);
  assert.equal(p('player_x'), Math.fround(g.player.x));

  const snap = JSON.parse(JSON.stringify(Probe.snapshot(env.B)));
  assert.equal(snap.state, 'play');
  assert.equal(snap.seed, 'E-PROBE-1');
  assert.equal(snap.probe.health, 5);
  assert.deepEqual(snap.room.enemies.map((e) => e.id).sort(), ['bug', 'bug', 'null_pointer']);
  assert.equal(snap.player.health, 5);

  const boss = createEnv({ observe: 'none' });   // bosses have no reviewed view yet
  const bossId = Object.keys(boss.gameSource.createInstance().B.BOSSES)[0];
  boss.reset({ kind: 'test_room', seed: 'E-PROBE-2', boss: bossId, player: { god: true } });
  Probe.write(boss.B, vec, 1);
  assert.equal(p('room_type'), Probe.ROOM_TYPES.indexOf('boss'));
  assert.ok(p('boss_hp') > 0 && p('boss_hp') <= p('boss_hp_max'));
});

test('control calls: allowlist, tamper mark, and no way in through step()', () => {
  const env = createEnv({ record: true });
  assert.throws(() => env.call('snapshot'), /reset\(\) first/);
  env.reset(ROOM);
  env.step(0, 0, 0, 0);
  assert.equal(env.call('snapshot').room.enemies.length, 2);
  assert.match(env.call('signature'), /^[0-9a-f]{16}$/);
  assert.equal(env.episode.tampered, false, 'reading calls leave the episode untouched');
  assert.throws(() => env.call('handleKeys'), /unknown control call/);
  assert.throws(() => env.call('reveal'), /unknown control call/);
  assert.throws(() => env.call('__proto__'), /unknown control call/);
  assert.throws(() => env.call('constructor'), /unknown control call/);
  assert.throws(() => env.call('__throw'), /unknown control call/, 'test hooks are off by default');
  assert.throws(() => env.call('spawn', ['no_such_enemy']), /unknown enemy id/);
  assert.throws(() => env.call('giveItem', []), /item id must be/);
  assert.equal(env.episode.tampered, false, 'refused calls leave no mark');

  env.call('killAll');
  assert.equal(env.episode.tampered, true);
  const ep = env.step(0, 0, 0, 0);
  assert.equal(ep.reason, 'room_clear');
  assert.equal(env.events.counts[at('kills')], 0, 'kills by a control call are not credited to the agent');
  assert.equal(env.events.counts[at('rooms_cleared')], 1);
  assert.equal(env.transcript().tampered, true);
  assert.deepEqual(Control.NAMES.slice().sort(), ['giveItem', 'god', 'gotoRoom', 'killAll', 'nextFloor', 'resources', 'signature', 'snapshot', 'spawn', 'spawnBoss']);

  const hooks = createEnv({ testHooks: true });
  hooks.reset(ROOM);
  hooks.call('__consoleError');
  const faulted = hooks.step(0, 0, 0, 0);
  assert.equal(faulted.fault.kind, 'console');
  assert.match(faulted.fault.message, /injected listener error/);
});

test('scenario errors say whether another seed could help', () => {
  const env = createEnv();
  assert.throws(() => env.reset({ kind: 'test_room', seed: 'E-ERR-1', enemies: ['nope'] }), (err) => err.name === 'ScenarioError' && err.retryable === false);
  let retryable = null;
  for (let k = 0; k < 60 && retryable === null; k++) {
    try { env.reset({ kind: 'test_room', seed: `E-DOOR-${k}`, enemies: ['bug'], door: 'up' }); } catch (err) { retryable = err.retryable; assert.match(err.message, /use another seed/); }
  }
  assert.equal(retryable, true);
});
