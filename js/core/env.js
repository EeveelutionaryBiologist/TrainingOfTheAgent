/*
 * env.js — one environment: reset(scenario) and step(action) on top of a game instance.
 *
 * Responsibilities:
 *   - instance lifecycle: in-instance reset; a fresh instance after any fault
 *   - frame-skip (R4): one decision is held for `frameSkip` PLAY frames
 *   - non-play states (R5): floor card, room and floor transitions and the boss intro are stepped through inside
 *     reset()/step(), with no key events, so the caller only ever sees `play` or the end of the episode
 *   - end conditions: death and the end-of-cycle score card always; the scenario's endOn and time limit
 *   - faults (R6): an exception in the game, or a console.error from it, ends the episode as truncated with a
 *     fault record (seed, frame, state); it never propagates to the caller
 *   - recording: the key events of an episode, for replay (js/core/recorder.js)
 *   - privileged side channel (R12): event counters of the last decision (env.events) and control calls
 *     (env.call); neither is part of any observation
 *   - fair observation (R7–R9, js/core/observe.js): written after reset and after every decision; if the room
 *     holds something without a reviewed view, the episode ends as truncated with reason 'unreviewed'
 *
 * No Node dependencies: CommonJS module in Node, global `BotaEnv` in a browser page (after BotaSim, BotaScenario,
 * BotaEvents, BotaProbe, BotaControl and BotaObserve).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'), require('./scenario.js'), require('./events.js'), require('./control.js'), require('./observe.js'));
  else root.BotaEnv = factory(root.BotaSim, root.BotaScenario, root.BotaEvents, root.BotaControl, root.BotaObserve);
})(typeof self !== 'undefined' ? self : this, function (S, Scenario, Events, Control, Observe) {
  'use strict';

  const TRANSCRIPT_FORMAT = 1;
  // States the wrapper waits out. Anything else outside `play` means something reached the keyboard that never
  // should (pause, title, seed dialog) and is treated as a fault.
  const WAIT_STATES = ['floorCard', 'roomTransition', 'bossIntro', 'floorTransition'];
  const CONSOLE_LEVELS = { off: [], error: ['error'], warn: ['error', 'warn'] };

  class Env {
    /**
     * makeInstance: () => { B, host } — a fresh game instance (js/node/loader.js: game.createInstance)
     * opts: {
     *   frameSkip      play frames per decision (default 4)
     *   record         keep the key events of each episode (default false)
     *   consoleFaults  'error' (default) | 'warn' | 'off': which console output of the game ends the episode
     *   flowLimit      max consecutive non-play frames before the episode is declared stuck (default 1200)
     *   meta           free-form description stored in transcripts (game version, profile, ...)
     *   testHooks      allow the fault-injection control calls (the harness's own tests only)
     *   observe        'v2' (default) or 'none': which observation to produce. 'none' also switches the review
     *                  gate off; use it only where nothing is fed to a model (benchmarks, reward development)
     * }
     */
    constructor(makeInstance, opts) {
      const o = opts || {};
      this.makeInstance = makeInstance;
      this.frameSkip = o.frameSkip === undefined ? 4 : o.frameSkip;
      if (!Number.isInteger(this.frameSkip) || this.frameSkip < 1) throw new RangeError('frameSkip must be a positive integer');
      this.record = !!o.record;
      this.consoleLevels = CONSOLE_LEVELS[o.consoleFaults === undefined ? 'error' : o.consoleFaults];
      if (!this.consoleLevels) throw new RangeError('consoleFaults must be "error", "warn" or "off"');
      this.flowLimit = o.flowLimit || 1200;
      this.meta = o.meta || {};
      this.testHooks = !!o.testHooks;
      this.observer = Observe.create(o.observe === undefined ? Observe.ID : o.observe);   // null for 'none'
      this.events = null;    // EventCounter of the current instance: events of the last decision
      this.markFrame = -2;   // frame at which the observer last remembered positions
      this.inst = null;
      this.sim = null;
      this.broken = false;
      this.instancesBuilt = 0;
      this.episode = null;
    }

    get B() { return this.sim ? this.sim.B : null; }
    get game() { return this.sim ? this.sim.B.game : null; }

    /**
     * Start an episode. Throws ScenarioError for an invalid scenario (a configuration mistake of the caller).
     * A fault inside the game during setup does not throw: the returned episode is already over, reason 'fault'.
     */
    reset(spec) {
      const sc = Scenario.normalize(spec);
      if (!this.sim || this.broken) {
        this.inst = this.makeInstance();
        this.sim = new S.Sim(this.inst.B, this.inst.host);
        this.events = new Events.EventCounter(this.inst.B);
        this.broken = false;
        this.instancesBuilt++;
      }
      const sim = this.sim;
      sim.onKey = null;
      const ep = this.episode = {
        scenario: sc,
        done: false, terminated: false, truncated: false, reason: null, fault: null,
        tampered: false,     // a mutating control call was used: the key recording no longer explains the episode
        frame: 0,            // simulation frames since reset, play and non-play
        startFrame: 0,       // frame at which the agent got control
        playFrames: 0, nonPlayFrames: 0, decisions: 0,
        ctx: null, keys: null, codes: null, errMark: this.inst.host ? this.inst.host.errors.length : 0,
      };
      try {
        sim.reset(sc.seed, { depth: sc.depth });
        ep.ctx = Scenario.build(sim.B, sc);
        this._flow(ep);
      } catch (err) {
        if (err instanceof Scenario.ScenarioError) { this.episode = null; throw err; }
        this._fault(ep, 'exception', err);
      }
      this._consoleCheck(ep);
      if (this.observer) {
        this.observer.reset();
        const missing = this._observe(ep);
        if (missing && !ep.fault) {
          // What the scenario sets up is the caller's choice, so this is a configuration mistake, not bad luck
          this.episode = null;
          throw new Scenario.ScenarioError(`observation ${this.observer.layout.id} has no reviewed view for: ${missing.join(', ')}`);
        }
      }
      this.events.clear();    // setup (items given, rooms entered) is not the agent's doing
      ep.frame = ep.startFrame = sim.frame;
      ep.nonPlayFrames = 0;   // counted from the moment the agent has control
      if (this.record && !ep.done) {
        ep.keys = []; ep.codes = [];
        sim.onKey = (code, down) => {
          let i = ep.codes.indexOf(code);
          if (i < 0) i = ep.codes.push(code) - 1;
          ep.keys.push(sim.frame, i, down ? 1 : 0);
        };
      }
      return ep;
    }

    /**
     * One agent decision: move 0..8, shoot 0..4, push 0|1, active 0|1 (see sim.js MOVES).
     * Returns the episode object; read done / terminated / truncated / reason / fault from it.
     */
    step(move, shoot, push, active) {
      const ep = this.episode;
      if (!ep || ep.done) throw new Error('step() called without a running episode; call reset() first');
      if (!Number.isInteger(move) || move < 0 || move > 8 || !Number.isInteger(shoot) || shoot < 0 || shoot > 4) {
        throw new RangeError(`action out of range: move ${move} (0..8), shoot ${shoot} (0..4)`);
      }
      const sim = this.sim;
      this.events.clear();
      try {
        S.applyAction(sim, move, shoot, push ? 1 : 0, active ? 1 : 0);
        ep.decisions++;
        for (let n = 0; n < this.frameSkip && !ep.done; n++) {
          if (this.observer && n === this.frameSkip - 1) { this.observer.mark(sim.B); this.markFrame = sim.frame; }
          sim.step();
          ep.playFrames++;
          this._checkEnd(ep);
          if (!ep.done && sim.B.game.state !== 'play') this._flow(ep);
        }
      } catch (err) {
        this._fault(ep, 'exception', err);
      }
      this._consoleCheck(ep);
      ep.frame = sim.frame;
      if (this.observer) {
        const missing = this._observe(ep);
        if (missing && !ep.done) {
          // Review gate: neither show the model something unchecked nor hide something a human would see
          ep.done = ep.truncated = true; ep.reason = 'unreviewed';
          ep.fault = {
            kind: 'unreviewed', message: `no reviewed view for: ${missing.join(', ')}`, stack: null, what: missing,
            frame: sim.frame, state: sim.B.game.state, seed: ep.scenario.seed, scenario: ep.scenario,
          };
        }
      }
      if (ep.done) this._finish();
      return ep;
    }

    /** Write the observation of the current frame; returns the unreviewed things in the room, or null */
    _observe(ep) {
      const obs = this.observer;
      if (ep.fault) { obs.blank(); return null; }   // the game state cannot be trusted after a fault
      try {
        // Velocities need the positions of the frame before; without them everything counts as newly appeared
        if (this.markFrame !== this.sim.frame - 1) obs.reset();
        return obs.write(this.sim.B, this.sim.host ? this.sim.host.clockMs : undefined);   // the clock the HUD draws with
      } catch (err) {
        obs.blank();
        this._fault(ep, 'exception', err);
        return null;
      }
    }

    /** The current observation as { field: typed array } (views into the observer's buffer), or null */
    observation() { return this.observer ? this.observer.f : null; }

    /** Step through non-play states without touching the keyboard */
    _flow(ep) {
      const sim = this.sim;
      this._checkEnd(ep);
      let n = 0;
      while (!ep.done && sim.B.game.state !== 'play') {
        const state = sim.B.game.state;
        if (!WAIT_STATES.includes(state)) throw new Error(`unexpected game state "${state}"`);
        if (++n > this.flowLimit) throw new Error(`stuck in game state "${state}" for ${this.flowLimit} frames`);
        sim.step();
        ep.nonPlayFrames++;
        this._checkEnd(ep);
      }
    }

    _checkEnd(ep) {
      if (ep.done) return;
      const g = this.sim.B.game, sc = ep.scenario, ctx = ep.ctx;
      let reason = null;
      if (g.state === 'dead') reason = 'death';
      else if (g.state === 'scoreCard') reason = 'cycle_end';
      else if (ctx) {
        if (sc.endOn.includes('room_clear') && ctx.targetRoom && ctx.targetRoom.cleared) reason = 'room_clear';
        else if (sc.endOn.includes('boss_kill') && g.room && g.room.type === 'boss' && g.room.cleared && g.room.bossId) reason = 'boss_kill';
        else if (sc.endOn.includes('floor_exit') && (g.state === 'floorTransition' || g.depth > ctx.startDepth)) reason = 'floor_exit';
      }
      if (reason) { ep.done = ep.terminated = true; ep.reason = reason; return; }
      if (sc.maxPlayFrames && ep.playFrames >= sc.maxPlayFrames) { ep.done = ep.truncated = true; ep.reason = 'time_limit'; }
    }

    _fault(ep, kind, err) {
      const sim = this.sim;
      let state = null;
      try { state = sim.B.game.state; } catch (e) { /* the game object itself may be broken */ }
      ep.done = true; ep.truncated = true; ep.terminated = false; ep.reason = 'fault';
      ep.fault = {
        kind,
        message: String(err && err.message !== undefined ? err.message : err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : null,
        frame: sim.frame, state, seed: ep.scenario.seed, scenario: ep.scenario,
      };
      this.broken = true;   // never reuse an instance after a fault
    }

    _consoleCheck(ep) {
      const host = this.inst.host;
      if (!host || !this.consoleLevels.length) return;
      for (let i = ep.errMark; i < host.errors.length; i++) {
        const e = host.errors[i];
        if (!this.consoleLevels.includes(e.level)) continue;
        if (!ep.fault) {
          this._fault(ep, 'console', new Error(`console.${e.level}: ${e.text}`));
          ep.fault.frame = e.frame;
          ep.fault.stack = null;
        }
        break;
      }
      ep.errMark = host.errors.length;
    }

    _finish() {
      this.sim.onKey = null;
      try { this.sim.releaseAll(); } catch (e) { /* instance is discarded anyway after a fault */ }
    }

    /**
     * Privileged control call on the running episode (js/core/control.js): debug hooks and state snapshots.
     * A call that changes the game marks the episode as tampered. Never reachable through step().
     */
    call(name, args) {
      const ep = this.episode;
      if (!ep || !this.sim || this.broken) throw new Error('call() needs an episode; call reset() first');
      const out = Control.call(this.sim.B, name, args, this.testHooks);
      if (out.mutates) ep.tampered = true;
      return out.result;
    }

    /**
     * Transcript of the current (usually finished) episode: enough to replay it frame by frame.
     * Requires opts.record. See js/core/recorder.js.
     */
    transcript() {
      const ep = this.episode;
      if (!ep || !ep.keys) throw new Error('no recording: create the Env with { record: true } and run an episode');
      const h = new S.Hasher();
      let signature = null;
      try { S.hashState(this.sim.B, h); signature = h.hex(); } catch (e) { /* state unusable after a fault */ }
      return {
        format: TRANSCRIPT_FORMAT,
        meta: this.meta,
        scenario: ep.scenario,
        frameSkip: this.frameSkip,
        startFrame: ep.startFrame,
        endFrame: ep.frame,
        codes: ep.codes.slice(),
        keys: ep.keys.slice(),      // flat triples: frame, index into codes, 1 = down / 0 = up
        result: { terminated: ep.terminated, truncated: ep.truncated, reason: ep.reason, playFrames: ep.playFrames, nonPlayFrames: ep.nonPlayFrames, decisions: ep.decisions },
        tampered: ep.tampered,      // true: control calls changed the game, a replay will not match
        signature,
      };
    }
  }

  return { Env, TRANSCRIPT_FORMAT, WAIT_STATES };
});
