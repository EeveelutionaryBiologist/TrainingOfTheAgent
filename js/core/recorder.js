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
   * Frame-by-frame replay of a transcript, for callers that want to stop in between (the browser viewer).
   * instance: { B, host } with no keys held (a fresh one, or one a previous replay finished on); host may be null.
   * The constructor rebuilds the scenario; then step() advances one frame until done.
   */
  class Replayer {
    constructor(instance, transcript) {
      this.transcript = validate(transcript);
      this.scenario = Scenario.normalize(this.transcript.scenario);
      this.sim = new S.Sim(instance.B, instance.host);
      this.sim.reset(this.scenario.seed, { depth: this.scenario.depth });
      Scenario.build(this.sim.B, this.scenario);
      this.next = 0;                                   // index into transcript.keys
      this.held = new Set();                           // key codes currently held by the recording
    }

    get frame() { return this.sim.frame; }
    get endFrame() { return this.transcript.endFrame; }
    get done() { return this.sim.frame >= this.transcript.endFrame; }

    /** Advance one frame (key events of this frame first, as Env did). Returns false once the recording is over. */
    step() {
      if (this.done) return false;
      const t = this.transcript, k = t.keys, sim = this.sim;
      if (sim.frame >= t.startFrame) {
        while (this.next < k.length && k[this.next] === sim.frame) {
          const code = t.codes[k[this.next + 1]], down = k[this.next + 2] === 1;
          sim.raw(code, down);
          if (down) this.held.add(code); else this.held.delete(code);
          this.next += 3;
        }
      }
      sim.step();
      return true;
    }

    /** Hash of the current state, compared with the recorded one. Releases all keys (the instance may be reused). */
    finish() {
      const h = new S.Hasher();
      S.hashState(this.sim.B, h);
      const signature = h.hex();
      this.sim.releaseAll();
      this.held.clear();
      return { ok: signature === this.transcript.signature, signature, expected: this.transcript.signature, frames: this.sim.frame, sim: this.sim };
    }
  }

  /**
   * Replay a transcript on an instance that has no keys held (a fresh one, or one a previous replay finished on).
   * instance: { B, host } (host may be null in a browser)
   * hooks: { onFrame(sim) } — called after every frame, e.g. to render
   * Returns { ok, signature, expected, frames }; ok means the final state hash equals the recorded one.
   */
  function replay(instance, transcript, hooks) {
    const r = new Replayer(instance, transcript);
    const onFrame = hooks && hooks.onFrame;
    while (r.step()) if (onFrame) onFrame(r.sim);
    return r.finish();
  }

  return { replay, validate, Replayer };
});
