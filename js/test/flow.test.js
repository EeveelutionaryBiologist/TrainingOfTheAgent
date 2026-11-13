'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('../node/index.js');
const { doorWalk } = require('./helpers.js');

test('full run: reset waits out the floor card, the agent starts in play', () => {
  const env = createEnv();
  const ep = env.reset({ kind: 'full_run', seed: 'F-RESET-1' });
  assert.equal(env.game.state, 'play');
  assert.ok(ep.startFrame >= 130 && ep.startFrame <= 134, `2.2 s floor card, got ${ep.startFrame} frames`);
  assert.equal(ep.frame, ep.startFrame);
  assert.deepEqual([ep.playFrames, ep.nonPlayFrames, ep.decisions, ep.done], [0, 0, 0, false]);
});

test('frame-skip: one decision is exactly N play frames', () => {
  for (const frameSkip of [1, 4, 8]) {
    const env = createEnv({ frameSkip });
    let ep = env.reset({ kind: 'full_run', seed: 'F-SKIP-1' });
    const start = ep.frame, t0 = env.game.runStats.time;
    for (let i = 1; i <= 5; i++) {
      ep = env.step(0, 0, 0, 0);
      assert.equal(ep.playFrames, i * frameSkip);
      assert.equal(ep.frame, start + i * frameSkip);
    }
    assert.ok(Math.abs(env.game.runStats.time - t0 - (5 * frameSkip) / 60) < 1e-9, 'game clock advanced by the same amount');
  }
  assert.throws(() => createEnv({ frameSkip: 0 }), RangeError);
});

test('walking through a door: the transition is invisible to the agent', () => {
  const env = createEnv();
  let ep = env.reset({ kind: 'full_run', seed: 'F-DOOR-1', player: { god: true } });
  const B = env.B, g = env.game, start = g.room;

  // Record every key-down with the game state it arrived in
  const downs = [];
  const simulate = B.input._simulate;
  B.input._simulate = (code, down, key) => { if (down) downs.push(B.game.state); return simulate(code, down, key); };

  const { policy } = doorWalk(B);
  let crossedAt = -1;
  for (let i = 0; i < 400 && crossedAt < 0; i++) {
    const before = ep.playFrames;
    ep = env.step(policy()[0], 0, 0, 0);
    assert.equal(ep.playFrames, before + 4, 'every decision is 4 play frames, door or not');
    assert.equal(g.state, 'play', 'the agent never sees a non-play state');
    if (g.room !== start) crossedAt = i;
  }
  assert.ok(crossedAt >= 0, 'reached the next room');
  const expected = g.room.type === 'boss' ? null : 17;
  if (expected) assert.equal(ep.nonPlayFrames, expected, 'the 0.28 s slide was stepped through inside step()');
  assert.equal(ep.frame, ep.startFrame + ep.playFrames + ep.nonPlayFrames);
  assert.ok(downs.length > 0 && downs.every((s) => s === 'play'), 'keys are only ever pressed in play');
});

test('step() refuses bad actions and finished episodes', () => {
  const env = createEnv();
  assert.throws(() => env.step(0, 0, 0, 0), /reset\(\) first/);
  env.reset({ kind: 'test_room', seed: 'F-ERR-1', enemies: ['bug'], player: { god: true }, maxPlayFrames: 4 });
  assert.throws(() => env.step(9, 0, 0, 0), RangeError);
  assert.throws(() => env.step(0, 5, 0, 0), RangeError);
  assert.throws(() => env.step(1.5, 0, 0, 0), RangeError);
  assert.equal(env.step(0, 0, 0, 0).done, true);
  assert.throws(() => env.step(0, 0, 0, 0), /reset\(\) first/);
});
