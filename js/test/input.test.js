'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, Sim } = require('../node/index.js');

const ALLOWED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyE', 'Space']);

test('Force Push is edge-triggered: one bomb per push action', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'I-PUSH-1', player: { pushes: 3, god: true } });
  const g = env.game, bombs = () => g.room.projectiles.filter((q) => q instanceof env.B.Bomb).length;
  env.step(0, 0, 1, 0);
  assert.equal(g.player.pushes, 2);
  assert.equal(bombs(), 1);
  env.step(0, 0, 0, 0);
  assert.equal(g.player.pushes, 2, 'nothing repeats while the action is not chosen again');
  env.step(0, 0, 1, 0);
  env.step(0, 0, 1, 0);
  assert.equal(g.player.pushes, 0);
  assert.equal(bombs(), 3);
  env.step(0, 0, 1, 0);
  assert.equal(bombs(), 3, 'no pushes left, no bomb');
});

test('movement and shooting are held for the whole decision and released when not chosen', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'I-HOLD-1', player: { god: true } });
  const g = env.game, inp = env.B.input, x0 = g.player.x;
  env.step(4, 0, 0, 0);
  assert.equal(inp.down('KeyD'), true);
  env.step(4, 0, 0, 0);
  assert.ok(g.player.x > x0 + 5, 'moved right');
  env.step(1, 0, 0, 0);
  assert.equal(inp.down('KeyD'), false);
  assert.equal(inp.down('KeyW'), true);
  env.step(8, 4, 0, 0);
  assert.deepEqual(['KeyW', 'KeyA', 'KeyS', 'KeyD'].map((k) => inp.down(k)), [false, false, true, true], 'down-right holds S and D');
  assert.equal(inp.shootDir(), 'right');
  for (let i = 0; i < 6; i++) env.step(0, 4, 0, 0);
  const shots = g.room.projectiles.filter((q) => q.team === 'player');
  assert.ok(shots.length >= 1 && shots.every((q) => q.vx > 0), 'shots fly right');
  env.step(0, 0, 0, 0);
  assert.equal(inp.shootDir(), null);
  assert.equal(['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => inp.down(k)), false);
});

test('reset is clean even if another driver left keys held on the instance', () => {
  const a = createEnv({ record: true }), b = createEnv({ record: true });
  const spec = { kind: 'test_room', seed: 'I-STUCK-1', enemies: ['bug', 'bug'], maxPlayFrames: 400 };
  const play = (env) => { let ep = env.reset(spec); while (!ep.done) ep = env.step(0, 0, 0, 0); return env.transcript().signature; };
  const clean = play(a);
  // A second driver on b's instance presses keys and walks away without releasing them
  b.reset(spec);
  const stray = new Sim.Sim(b.B, b.inst.host);
  stray.key('KeyD', true); stray.key('ArrowLeft', true);
  assert.equal(b.B.input.down('KeyD'), true);
  assert.equal(play(b), clean, 'the next episode is unaffected');
  assert.equal(b.B.input.down('KeyD'), false);
});

test('R11: the action space reaches only the ten gameplay keys, never pause, restart, mute or debug', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'I-FUZZ-1', player: { god: true, pushes: 99 } });
  const B = env.B, codes = new Set();
  const simulate = B.input._simulate;
  B.input._simulate = (code, down, key) => { codes.add(code); return simulate(code, down, key); };
  const rnd = Sim.mulberry32(2024);
  const game = env.game;
  for (let i = 0; i < 3000; i++) {
    const ep = env.step(Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.3 ? 1 : 0, rnd() < 0.3 ? 1 : 0);
    assert.equal(ep.done, false, `episode ended at decision ${i}: ${ep.reason}`);
  }
  for (const code of codes) assert.ok(ALLOWED.has(code), `unexpected key ${code}`);
  assert.equal(codes.size, ALLOWED.size, 'the fuzz used every allowed key');
  assert.equal(B.debug.enabled, false);
  assert.equal(B.debug.revealMap, false);
  assert.equal(env.game, game, 'no restart: still the same Game object');
  assert.equal(game.seed, 'I-FUZZ-1');
  assert.equal(game.state, 'play');
  assert.equal(game.player.god, true, 'god mode came from the scenario and was not toggled');
});
