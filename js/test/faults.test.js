'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, getGame, Env } = require('../node/index.js');

test('an exception in the game ends the episode as a fault and the instance is replaced', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'X-BOOM-1' });
  const first = env.inst;
  env.game.room.update = () => { throw new Error('boom'); };
  const ep = env.step(0, 0, 0, 0);
  assert.equal(ep.done, true);
  assert.equal(ep.truncated, true);
  assert.equal(ep.terminated, false);
  assert.equal(ep.reason, 'fault');
  assert.equal(ep.fault.kind, 'exception');
  assert.match(ep.fault.message, /boom/);
  assert.equal(ep.fault.seed, 'X-BOOM-1');
  assert.equal(ep.fault.frame, ep.startFrame, 'the frame that failed');
  assert.equal(ep.fault.state, 'play');
  assert.ok(ep.fault.stack.includes('boom'));

  const next = env.reset({ kind: 'full_run', seed: 'X-BOOM-2' });
  assert.notEqual(env.inst, first, 'a fresh instance after a fault');
  assert.equal(env.instancesBuilt, 2);
  assert.equal(next.done, false);
  assert.equal(env.step(0, 0, 0, 0).done, false);
});

test('errors the game swallows and logs (item hooks) are faults too', () => {
  const spec = { kind: 'full_run', seed: 'X-HOOK-1' };
  const breakHook = (env) => {
    const id = Object.keys(env.B.ITEMS).find((k) => !env.B.ITEMS[k].active);
    env.game.player.giveItem(id, env.game);
    env.B.ITEMS[id].update = () => { throw new Error('hook boom'); };
  };

  const strict = createEnv();
  strict.reset(spec);
  breakHook(strict);
  const ep = strict.step(0, 0, 0, 0);
  assert.equal(ep.reason, 'fault');
  assert.equal(ep.fault.kind, 'console');
  assert.match(ep.fault.message, /console\.error: \[item\].*hook boom/s);
  assert.equal(strict.broken, true);

  const lax = createEnv({ consoleFaults: 'off' });
  lax.reset(spec);
  breakHook(lax);
  assert.equal(lax.step(0, 0, 0, 0).done, false, 'with consoleFaults off the episode goes on, as it would in a browser');
});

test('a fault during reset is reported, not thrown', () => {
  const game = getGame();
  let broken = true;
  const env = new Env(() => {
    const inst = game.createInstance();
    if (broken) inst.B.Game.prototype.enterFloor = () => { throw new Error('reset boom'); };
    return inst;
  });
  const ep = env.reset({ kind: 'full_run', seed: 'X-RESET-1' });
  assert.equal(ep.done, true);
  assert.equal(ep.reason, 'fault');
  assert.match(ep.fault.message, /reset boom/);
  broken = false;
  assert.equal(env.reset({ kind: 'full_run', seed: 'X-RESET-1' }).done, false);
});

test('a game stuck outside play, or in a state the keyboard should never reach, is a fault', () => {
  const stuck = createEnv({ flowLimit: 10 });
  const ep = stuck.reset({ kind: 'full_run', seed: 'X-STUCK-1' });   // the floor card alone is 132 frames
  assert.equal(ep.reason, 'fault');
  assert.match(ep.fault.message, /stuck in game state "floorCard"/);

  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'X-PAUSE-1' });
  env.game.setState('pause');
  const ep2 = env.step(0, 0, 0, 0);
  assert.equal(ep2.reason, 'fault');
  assert.match(ep2.fault.message, /unexpected game state "pause"/);
});
