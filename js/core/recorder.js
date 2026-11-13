/*
 * recorder.js — replay of a recorded episode (R22).
 *
 * A transcript (Env.transcript()) holds the scenario and every key event with the frame it applies to. Replay
 * deliberately does NOT go through Env: it rebuilds the scenario and then runs a plain frame loop, feeding the
 * recorded events. That is exactly what a browser replay does, and it checks that nothing in an episode depends
 * on the wrapper's own bookkeeping.
 *
 * No Node dependencies: CommonJS module in Node, global `BotaRecorder` in a browser page (after BotaSim and
 * BotaScenario).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'), require('./scenario.js'));
  else root.BotaRecorder = factory(root.BotaSim, root.BotaScenario);
})(typeof self !== 'undefined' ? self : this, function (S, Scenario) {
  'use strict';

  /** Structural check of a transcript; throws on anything a replay could not run */
  function validate(t) {
    if (!t || t.format !== 1) throw new Error('unsupported transcript format');
    if (!Array.isArray(t.keys) || t.keys.length % 3 !== 0 || !Array.isArray(t.codes)) throw new Error('transcript.keys / codes malformed');
    if (!Number.isInteger(t.startFrame) || !Number.isInteger(t.endFrame) || t.endFrame < t.startFrame) throw new Error('transcript frame range malformed');
    let last = t.startFrame;
    for (let i = 0; i < t.keys.length; i += 3) {
      const frame = t.keys[i], code = t.keys[i + 1];
      if (!Number.isInteger(frame) || frame < last || frame > t.endFrame) throw new Error(`transcript key event ${i / 3} is out of order or out of range`);
      if (!Number.isInteger(code) || code < 0 || code >= t.codes.length) throw new Error(`transcript key event ${i / 3} names an unknown key`);
      last = frame;
    }
    return t;
  }

  /**
   * Replay a transcript on an instance that has no keys held (a fresh one, or one a previous replay finished on).
   * instance: { B, host } (host may be null in a browser)
   * hooks: { onFrame(sim) } — called after every frame, e.g. to render
   * Returns { ok, signature, expected, frames }; ok means the final state hash equals the recorded one.
   */
  function replay(instance, transcript, hooks) {
    const t = validate(transcript);
    const sc = Scenario.normalize(t.scenario);
    const sim = new S.Sim(instance.B, instance.host);
    sim.reset(sc.seed, { depth: sc.depth });
    Scenario.build(sim.B, sc);
    const onFrame = hooks && hooks.onFrame;
    while (sim.frame < t.startFrame) { sim.step(); if (onFrame) onFrame(sim); }
    const k = t.keys;
    let i = 0;
    while (sim.frame < t.endFrame) {
      while (i < k.length && k[i] === sim.frame) { sim.raw(t.codes[k[i + 1]], k[i + 2] === 1); i += 3; }
      sim.step();
      if (onFrame) onFrame(sim);
    }
    const h = new S.Hasher();
    S.hashState(sim.B, h);
    const signature = h.hex();
    sim.releaseAll();   // leave no key held in the game's input module (the instance may be reused)
    return { ok: signature === t.signature, signature, expected: t.signature, frames: sim.frame, sim };
  }

  return { replay, validate };
});
