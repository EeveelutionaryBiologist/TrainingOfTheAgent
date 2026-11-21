/*
 * The named scenarios in scenarios/: every file is a valid scenario and starts, and each one does what its
 * description says.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv, Scenario, Observe } = require('../node/index.js');
const { hunt, charge, run } = require('./helpers.js');
const { decode, V } = require('./obs_helpers.js');

const DIR = path.join(__dirname, '..', '..', 'scenarios');
const NOTES = ['description', 'observation'];
/** The scenario of a file, as Python's load_scenario hands it over: notes dropped, seed drawn by the env */
function load(name, seed) {
  const spec = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  for (const k of NOTES) delete spec[k];
  return Object.assign({ seed }, spec);
}
const NAMES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

/** Start `name` on up to 20 seeds; seeds the scenario does not fit (retryable errors) are skipped, as the env does */
function starts(env, name, want) {
  let ok = 0;
  for (let k = 0; k < 20 && ok < want; k++) {
    try {
      const ep = env.reset(load(name, `NAMED-${k}`));
      assert.equal(ep.done, false, `${name}: starts (${ep.fault && ep.fault.message})`);
      ok++;
    } catch (err) {
      if (!(err instanceof Scenario.ScenarioError) || !err.retryable) throw err;
    }
  }
  return ok;
}

test('every scenario file is valid, described, leaves the seed to the env, and starts', () => {
  assert.ok(NAMES.includes('single_bug'));
  const fair = createEnv(), bare = createEnv({ observe: 'none' });
  const reviewed = new Set(Observe.LAYOUT.reviewed.enemies);
  for (const name of NAMES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
    assert.equal(typeof raw.description, 'string', `${name}: has a description`);
    assert.ok(raw.description.length > 10, `${name}: the description says something`);
    assert.equal(raw.seed, undefined, `${name}: no fixed seed, so every episode gets a fresh floor`);
    assert.ok(raw.observation === undefined || raw.observation === 'none', `${name}: "observation" is "none" or absent`);
    Scenario.normalize(load(name, 'NAMED-0'));
    const needsNone = raw.observation === 'none';
    assert.equal(starts(needsNone ? bare : fair, name, 3), 3, `${name}: starts on three seeds`);
    // the note must be honest: test rooms without it use reviewed content only, test rooms with it do not
    if (raw.kind === 'test_room') {
      const ids = (raw.enemies || []).map((e) => (typeof e === 'string' ? e : e.id));
      const unreviewed = raw.boss !== undefined || ids.some((id) => !reviewed.has(id));
      assert.equal(needsNone, unreviewed, `${name}: "observation": "none" ${unreviewed ? 'is needed' : 'is not needed'}`);
    }
  }
});

test('the id catalog in scenarios/README.md is up to date', () => {
  const Catalog = require('../node/catalog.js');
  assert.equal(Catalog.readmeSection(), Catalog.catalog(), 'regenerate it: node js/node/catalog.js --write');
});

test('single_bug: one Bug and nothing else, through a real door; cleared by killing it, lost by dying, capped at 60 s', () => {
  const env = createEnv();
  for (const seed of ['SB-1', 'SB-2', 'SB-3', 'SB-4']) {
    let ep = env.reset(load('single_bug', seed));
    const g = env.game, room = g.room;
    assert.deepEqual(room.enemies.map((e) => e.id), ['bug'], `${seed}: exactly one Bug`);
    assert.notEqual(room, g.floor.startRoom, `${seed}: not the start room`);
    assert.equal(room.combatClosed, true, `${seed}: the doors closed behind the player`);
    assert.equal(room.pickups.length, 0, `${seed}: nothing on the floor`);
    for (let i = 0; i < room.tiles.length; i++) {
      const r = Math.floor(i / 15), c = i % 15;
      if (r > 0 && r < 8 && c > 0 && c < 14) assert.equal(room.tiles[i], env.B.TILES.FLOOR, `${seed}: empty layout`);
    }
    assert.equal(ep.scenario.maxPlayFrames, 3600, `${seed}: 60 s time limit`);
    const o = decode(env.observation());
    assert.deepEqual(o.enemies.map((e) => e.typeName), ['enemy_bug'], `${seed}: the observation shows one Bug`);
    assert.ok(V.sprites.includes('enemy_bug'));

    ep = run(env, hunt, 2000);
    assert.equal(ep.reason, 'room_clear', `${seed}: hunting the Bug clears the room`);
    assert.equal(ep.terminated, true);
  }

  // standing still, the wandering Bug does not finish the player: the episode runs into its time limit,
  // 60 s of play = 3600 frames = 900 decisions at frame-skip 4
  let ep = env.reset(load('single_bug', 'SB-IDLE'));
  ep = run(env, () => [0, 0], 1000);
  assert.deepEqual([ep.reason, ep.truncated, ep.terminated, ep.playFrames, ep.decisions], ['time_limit', true, false, 3600, 900]);

  // walking into it without shooting loses eventually
  ep = env.reset(load('single_bug', 'SB-CHARGE'));
  ep = run(env, charge, 1000);
  assert.equal(ep.reason, 'death');
});
