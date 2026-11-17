'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, Scenario } = require('../node/index.js');
const { hunt, charge, walkTo, run } = require('./helpers.js');

test('test room with two Bugs: a real fight that runs to room clear', () => {
  const env = createEnv();
  let ep = env.reset({ kind: 'test_room', seed: 'T-CLEAR-1', enemies: [{ id: 'bug', count: 2 }], maxPlayFrames: 3600 });
  const g = env.game, room = g.room;
  assert.equal(g.state, 'play');
  assert.equal(ep.startFrame, 17, 'only the 0.28 s room slide precedes the first decision');
  assert.equal(room, ep.ctx.targetRoom);
  assert.equal(room.combatClosed, true, 'doors close for the fight');
  assert.deepEqual(room.enemies.map((e) => e.id), ['bug', 'bug']);
  assert.ok(room.enemies.every((e) => e.spawnDelay > 0.4), 'enemies still have their spawn delay');
  assert.equal(room.pickups.length, 0, 'no loose loot in a constructed room');

  ep = run(env, hunt, 900);
  assert.equal(ep.done, true);
  assert.equal(ep.terminated, true);
  assert.equal(ep.truncated, false);
  assert.equal(ep.reason, 'room_clear');
  assert.equal(room.cleared, true);
  assert.equal(room.combatClosed, false, 'doors reopen');
  assert.equal(g.score.rooms, 1, 'the game scored the room like a real one');
  assert.equal(g.score.kills, 2);
});

test('test room runs to death', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'T-DEATH-1', enemies: [{ id: 'bug', count: 6 }], player: { health: 1 }, maxPlayFrames: 7200 });
  assert.equal(env.game.player.health, 1);
  const ep = run(env, charge, 1800);
  assert.equal(ep.reason, 'death');
  assert.equal(ep.terminated, true);
  assert.equal(env.game.state, 'dead');
});

test('time limit truncates after exactly maxPlayFrames play frames', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'T-TIME-1', enemies: ['bug'], player: { god: true }, maxPlayFrames: 40 });
  let steps = 0, ep = env.episode;
  while (!ep.done) { ep = env.step(0, 0, 0, 0); steps++; }
  assert.equal(steps, 10);
  assert.equal(ep.playFrames, 40);
  assert.equal(ep.reason, 'time_limit');
  assert.equal(ep.truncated, true);
  assert.equal(ep.terminated, false);
});

test('layouts: named, custom rows, generated', () => {
  const env = createEnv();
  const rows = ['.............', '..r.......b..', '.............', '......p......', '.............', '..s.......e..', '.............'];
  env.reset({ kind: 'test_room', seed: 'T-LAYOUT-1', layout: { rows }, enemies: ['bug'] });
  const T = env.B.TILES, room = env.game.room;
  assert.equal(room.tileAt(3, 2), T.ROCK);
  assert.equal(room.tileAt(11, 2), T.BLOCK);
  assert.equal(room.tileAt(7, 4), T.PIT);
  assert.equal(room.tileAt(3, 6), T.SPIKES);
  assert.equal(room.spawnPoints.length, 1, "the layout's 'e' tile is the spawn point");

  const named = env.B.LAYOUTS.find((l) => l.tags.includes('normal') && l.id !== 'empty');
  env.reset({ kind: 'test_room', seed: 'T-LAYOUT-1', layout: named.id, enemies: ['bug'] });
  assert.equal(env.game.room.layout.id, named.id);

  env.reset({ kind: 'test_room', seed: 'T-LAYOUT-1', layout: 'generated', enemies: ['bug'] });
  assert.ok(env.game.room.layout, 'keeps the layout the floor generator rolled');

  // A layout that walls off a door is refused by the game's own validator
  const blocked = rows.slice();
  blocked[0] = '......b......';
  assert.throws(() => env.reset({ kind: 'test_room', seed: 'T-LAYOUT-1', layout: { rows: blocked }, enemies: ['bug'] }), Scenario.ScenarioError);
});

test('player setup: items, health, resources', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'T-PLAYER-0' });
  const itemId = Object.keys(env.B.ITEMS).find((id) => !env.B.ITEMS[id].active);
  env.reset({ kind: 'full_run', seed: 'T-PLAYER-1', player: { items: [itemId], maxHealth: 8, health: 3, guardrails: 2, credits: 7, pushes: 5, approvals: 2 } });
  const p = env.game.player;
  assert.ok(p.items.includes(itemId));
  assert.deepEqual([p.maxHealth, p.health, p.guardrails, p.credits, p.pushes, p.approvals], [8, 3, 2, 7, 5, 2]);
  assert.equal(p.god, false);
});

test('boss test room: intro is skipped for the agent, clear drops a trapdoor, trapdoor ends on floor_exit', () => {
  const env = createEnv({ observe: 'none' });   // bosses have no reviewed view yet
  let ep = env.reset({ kind: 'test_room', seed: 'T-BOSS-1', boss: 'monolith', player: { god: true }, endOn: ['floor_exit'], maxPlayFrames: 6000 });
  const g = env.game, B = env.B, room = g.room;
  assert.equal(g.state, 'play');
  assert.ok(ep.startFrame > 17 + 100, 'room slide plus the 2.2 s boss intro happen before the first decision');
  assert.equal(room.type, 'boss');
  assert.ok(room.enemies.some((e) => e.isBoss));
  assert.equal(room.combatClosed, true);

  for (let i = 0; i < 100 && !room.cleared; i++) { B.debug.killAll(); ep = env.step(0, 0, 0, 0); }
  assert.equal(room.cleared, true);
  assert.equal(ep.done, false, 'boss_kill is not an end condition here');
  const trap = room.pickups.find((q) => q instanceof B.Trapdoor);
  assert.ok(trap, 'a cleared boss room has a trapdoor');
  ep = run(env, () => [walkTo(B, trap.x, trap.y, 4), 0], 600);
  assert.equal(ep.reason, 'floor_exit');
  assert.equal(ep.terminated, true);
});

test('boss_kill end condition', () => {
  const env = createEnv({ observe: 'none' });   // bosses have no reviewed view yet
  let ep = env.reset({ kind: 'test_room', seed: 'T-BOSS-2', boss: 'monolith', player: { god: true }, endOn: ['boss_kill'] });
  for (let i = 0; i < 100 && !ep.done; i++) { env.B.debug.killAll(); ep = env.step(0, 0, 0, 0); }
  assert.equal(ep.reason, 'boss_kill');
});

test('full run: other floors, no test-room fields', () => {
  const env = createEnv();
  const ep = env.reset({ kind: 'full_run', seed: 'T-FULL-1', depth: 4 });
  assert.equal(env.game.depth, 4);
  assert.equal(ep.ctx.targetRoom, null);
  assert.equal(env.game.room, env.game.floor.start.room);
});

test('door option and seeds without a usable room fail with a clear error', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'T-DOOR-1' });
  const doors = env.game.room.doors;
  const missing = Scenario.DOOR_ORDER.find((d) => !doors[d]);
  if (missing) {
    assert.throws(() => env.reset({ kind: 'test_room', seed: 'T-DOOR-1', door: missing, enemies: ['bug'] }), /no unlocked normal room behind its/);
  }
  const present = Scenario.DOOR_ORDER.find((d) => doors[d] && doors[d].target.room.type === 'normal');
  const ep = env.reset({ kind: 'test_room', seed: 'T-DOOR-1', door: present, enemies: ['bug'] });
  assert.equal(ep.ctx.entryDir, present);
});

test('invalid scenarios are rejected before the game is touched', () => {
  const env = createEnv();
  const bad = [
    {},
    { kind: 'nope', seed: 'A' },
    { kind: 'full_run', seed: 'has space' },
    { kind: 'full_run', seed: 'A', depth: 0 },
    { kind: 'full_run', seed: 'A', enemies: ['bug'] },
    { kind: 'full_run', seed: 'A', endOn: ['room_clear'] },
    { kind: 'full_run', seed: 'A', typo: 1 },
    { kind: 'full_run', seed: 'A', player: { health: 0 } },
    { kind: 'full_run', seed: 'A', player: { maxHealth: 5 } },
    { kind: 'test_room', seed: 'A' },
    { kind: 'test_room', seed: 'A', enemies: 'bug' },
    { kind: 'test_room', seed: 'A', enemies: ['bug'], boss: 'monolith' },
    { kind: 'test_room', seed: 'A', enemies: ['bug'], endOn: ['win'] },
    { kind: 'test_room', seed: 'A', enemies: [{ id: 'bug', count: 400 }] },
    { kind: 'test_room', seed: 'A', enemies: ['bug'], layout: { rows: ['short'] } },
  ];
  for (const spec of bad) assert.throws(() => env.reset(spec), Scenario.ScenarioError, JSON.stringify(spec));
  assert.equal(env.instancesBuilt, 0, 'validation happens before an instance is built');
  // These need the game's registries, so they fail during the build
  for (const spec of [
    { kind: 'test_room', seed: 'A', enemies: ['not_an_enemy'] },
    { kind: 'test_room', seed: 'A', boss: 'not_a_boss' },
    { kind: 'test_room', seed: 'A', enemies: ['bug'], layout: 'not_a_layout' },
    { kind: 'full_run', seed: 'A', player: { items: ['not_an_item'] } },
    { kind: 'full_run', seed: 'A', player: { health: 9 } },
  ]) assert.throws(() => env.reset(spec), Scenario.ScenarioError, JSON.stringify(spec));
  // The env is still usable afterwards
  assert.equal(env.reset({ kind: 'full_run', seed: 'A' }).done, false);
});
