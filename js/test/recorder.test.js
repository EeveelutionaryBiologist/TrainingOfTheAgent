'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, Recorder, Sim } = require('../node/index.js');
const { doorWalk, run } = require('./helpers.js');

function randomEpisode(env, spec, policySeed, maxSteps) {
  const rnd = Sim.mulberry32(policySeed);
  let ep = env.reset(spec);
  for (let i = 0; i < maxSteps && !ep.done; i++) {
    ep = env.step(Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.05 ? 1 : 0, rnd() < 0.05 ? 1 : 0);
  }
  return ep;
}

const ROOM = { kind: 'test_room', seed: 'R-ROOM-1', enemies: [{ id: 'bug', count: 3 }, 'null_pointer'], player: { pushes: 5 }, maxPlayFrames: 2400 };

test('a recorded episode replays to the identical state on a fresh instance', () => {
  const env = createEnv({ record: true });
  const ep = randomEpisode(env, ROOM, 7, 1000);
  assert.equal(ep.done, true);
  const t = JSON.parse(JSON.stringify(env.transcript()));   // survives JSON
  assert.equal(t.format, 1);
  assert.equal(t.meta.game.commit, env.gameSource.source.commit);
  assert.equal(t.meta.detMath, true);
  assert.equal(t.endFrame, ep.frame);
  assert.ok(t.keys.length > 0 && t.keys.length % 3 === 0);

  const res = Recorder.replay(env.gameSource.createInstance(), t);
  assert.equal(res.ok, true, `replay signature ${res.signature} vs recorded ${res.expected}`);
  assert.equal(res.frames, t.endFrame);
});

test('replay notices a changed input', () => {
  const env = createEnv({ record: true });
  randomEpisode(env, ROOM, 7, 1000);
  const t = env.transcript();
  const swapped = Object.assign({}, t, { codes: t.codes.map((c) => (c === 'KeyA' ? 'KeyD' : c === 'KeyD' ? 'KeyA' : c)) });
  assert.equal(Recorder.replay(env.gameSource.createInstance(), swapped).ok, false);
});

test('replay covers death, a full run on a deeper floor, and a door crossing', () => {
  const env = createEnv({ record: true });
  let ep = randomEpisode(env, { kind: 'test_room', seed: 'R-DEATH-1', enemies: [{ id: 'null_pointer', count: 8 }], player: { health: 2 } }, 3, 3000);
  assert.equal(ep.reason, 'death');
  let res = Recorder.replay(env.gameSource.createInstance(), env.transcript());
  assert.equal(res.ok, true);
  assert.equal(res.sim.game.state, 'dead');

  ep = randomEpisode(env, { kind: 'full_run', seed: 'R-FULL-1', depth: 3, maxPlayFrames: 6000 }, 11, 1500);
  res = Recorder.replay(env.gameSource.createInstance(), env.transcript());
  assert.equal(res.ok, true);

  // Walk from the start room into the next one, then stand there for a while
  ep = env.reset({ kind: 'full_run', seed: 'R-DOOR-1', player: { god: true }, maxPlayFrames: 1200 });
  const { policy, start } = doorWalk(env.B);
  ep = run(env, policy, 400);
  assert.notEqual(env.game.room, start, 'the recorded episode left the start room');
  assert.ok(ep.nonPlayFrames >= 17, 'and contains the room transition');
  res = Recorder.replay(env.gameSource.createInstance(), env.transcript());
  assert.equal(res.ok, true);
  assert.equal(res.sim.game.room.cell.x, env.game.room.cell.x);
  assert.equal(res.sim.game.room.cell.y, env.game.room.cell.y);
});

test('same scenario and actions give the same episode on a fresh env and on a reused one', () => {
  const a = createEnv({ record: true }), b = createEnv({ record: true });
  randomEpisode(a, ROOM, 21, 1000);
  const first = a.transcript();
  randomEpisode(b, { kind: 'full_run', seed: 'R-OTHER-1', maxPlayFrames: 800 }, 5, 400);   // b has history
  randomEpisode(b, ROOM, 21, 1000);
  const second = b.transcript();
  assert.equal(second.signature, first.signature);
  assert.equal(second.endFrame, first.endFrame);
  assert.deepEqual(second.keys, first.keys);
});

test('frame-skip only groups frames: 4 frames per decision equals 2 + 2 with the action repeated', () => {
  const spec = Object.assign({}, ROOM, { maxPlayFrames: 1600 });
  const rnd = Sim.mulberry32(99);
  const actions = Array.from({ length: 400 }, () => [Math.floor(rnd() * 9), Math.floor(rnd() * 5)]);   // no taps
  const four = createEnv({ record: true, frameSkip: 4 }), two = createEnv({ record: true, frameSkip: 2 });
  let a = four.reset(spec), b = two.reset(spec);
  for (const [m, s] of actions) {
    if (!a.done) a = four.step(m, s, 0, 0);
    for (let i = 0; i < 2 && !b.done; i++) b = two.step(m, s, 0, 0);
  }
  assert.equal(a.done, true);
  assert.equal(b.done, true);
  assert.equal(b.frame, a.frame);
  assert.equal(b.reason, a.reason);
  assert.equal(two.transcript().signature, four.transcript().signature);
});

test('transcript validation and misuse', () => {
  const env = createEnv();
  env.reset(ROOM);
  assert.throws(() => env.transcript(), /record: true/);
  const rec = createEnv({ record: true });
  randomEpisode(rec, ROOM, 1, 50);
  const t = rec.transcript();
  assert.throws(() => Recorder.validate(Object.assign({}, t, { format: 2 })), /format/);
  assert.throws(() => Recorder.validate(Object.assign({}, t, { keys: t.keys.slice(0, 4) })), /malformed/);
  assert.throws(() => Recorder.validate(Object.assign({}, t, { keys: [t.endFrame + 5, 0, 1] })), /out of order or out of range/);
  assert.throws(() => Recorder.validate(Object.assign({}, t, { keys: [t.startFrame, 99, 1] })), /unknown key/);
});
