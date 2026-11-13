/*
 * sim.js — host-agnostic simulation core: frame stepping, keyboard driver, action mapping, state hashing.
 *
 * No Node dependencies. Works as a CommonJS module and as a plain script in a browser page (global `BotaSim`),
 * so the Node workers and the browser determinism check / replay run the same code.
 *
 * `B` is the game's `window.BOTA` namespace. `host` is the Node host object from js/node/loader.js, or null in a
 * browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotaSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
  const SHOOT_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  // Move head: 0 = none, then up, down, left, right, up-left, up-right, down-left, down-right
  const MOVES = [[], ['KeyW'], ['KeyS'], ['KeyA'], ['KeyD'], ['KeyW', 'KeyA'], ['KeyW', 'KeyD'], ['KeyS', 'KeyA'], ['KeyS', 'KeyD']];
  const TAP_KEYS = ['KeyE', 'Space'];   // Force Push, active item
  const GAME_KEYS = MOVE_KEYS.concat(SHOOT_KEYS, TAP_KEYS);   // everything the action space can press
  const ACTION_NVEC = [9, 5, 2, 2]; // move, shoot, Force Push, active item
  const TERMINAL_STATES = ['dead', 'scoreCard'];

  /** Seeded PRNG (mulberry32); returns a function yielding floats in [0, 1) */
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a 32-bit string hash */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  /** Two-lane 32-bit hash over ints, float64 bit patterns and strings */
  class Hasher {
    constructor() {
      this.a = 0x811c9dc5;
      this.b = 0x9747b28c;
      this.f64 = new Float64Array(1);
      this.u32 = new Uint32Array(this.f64.buffer);
    }
    int(v) {
      v |= 0;
      this.a = Math.imul(this.a ^ v, 0x01000193);
      this.b = Math.imul(this.b ^ v, 0x85ebca6b);
      this.b ^= this.b >>> 13;
    }
    num(v) { this.f64[0] = +v; this.int(this.u32[0]); this.int(this.u32[1]); }
    str(s) { s = String(s); this.int(s.length); for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i)); }
    hex() { return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0'); }
  }

  /** Fold the gameplay-relevant state of a game into a hasher (visual effects are deliberately left out) */
  function hashState(B, h) {
    const g = B.game;
    h.str(g.state); h.int(g.depth); h.int(g.rng ? g.rng.state : 0); h.num(g.stateT);
    h.num(g.runStats.time); h.int(g.runStats.kills); h.int(g.runStats.rooms);
    for (const k of Object.keys(g.score)) h.int(g.score[k]);
    const p = g.player;
    if (p) {
      h.num(p.x); h.num(p.y); h.num(p.vx); h.num(p.vy); h.num(p.kbx); h.num(p.kby);
      h.num(p.health); h.num(p.maxHealth); h.num(p.guardrails);
      h.int(p.credits); h.int(p.pushes); h.int(p.approvals);
      h.num(p.fireCooldown); h.num(p.invuln);
      h.int(p.items.length);
      for (const id of p.items) h.str(id);
      h.str(p.active ? p.active.id : ''); h.num(p.active ? p.active.charge : 0);
      for (const k of Object.keys(p.stats)) h.num(p.stats[k]);
    }
    const room = g.room;
    if (room) {
      h.int(room.cell.x); h.int(room.cell.y); h.int((room.cleared ? 1 : 0) | (room.combatClosed ? 2 : 0));
      for (let i = 0; i < room.tiles.length; i++) h.int(room.tiles[i]);
      h.int(room.enemies.length);
      for (const e of room.enemies) { h.str(e.id); h.num(e.x); h.num(e.y); h.num(e.vx); h.num(e.vy); h.num(e.hp); h.int(e.dead ? 1 : 0); }
      h.int(room.projectiles.length);
      for (const q of room.projectiles) { h.num(q.x); h.num(q.y); h.num(q.vx); h.num(q.vy); h.str(q.team || ''); }
      h.int(room.pickups.length);
      for (const q of room.pickups) { h.str(q.type || q.itemId || ''); h.num(q.x); h.num(q.y); }
    }
    if (g.floor) {
      for (const c of g.floor.cells.values()) {
        const r = c.room;
        h.int((r.visited ? 1 : 0) | (r.seen ? 2 : 0) | (r.cleared ? 4 : 0) | (r.populated ? 8 : 0));
        for (const dir of Object.keys(r.doors)) h.int((r.doors[dir].edge.locked ? 1 : 0) | (r.doors[dir].edge.hidden ? 2 : 0));
      }
    }
    h.int(g.followers.length);
    for (const f of g.followers) { h.num(f.x); h.num(f.y); }
  }

  /** One game instance under program control */
  class Sim {
    constructor(B, host) {
      this.B = B;
      this.host = host || null;
      this.held = new Set();
      this.taps = [];
      this.frame = 0;
      // Optional hook (code, down), called for every key event sent to the game. `frame` is then the index of
      // the update that will see the event. Used by the recorder.
      this.onKey = null;
    }

    get game() { return this.B.game; }
    get state() { return this.B.game.state; }
    get terminal() { return TERMINAL_STATES.includes(this.B.game.state); }

    /** Hold or release a key (level-triggered keys: movement, shooting) */
    key(code, down) {
      if (down === this.held.has(code)) return;
      this.B.input._simulate(code, down);
      if (down) this.held.add(code); else this.held.delete(code);
      if (this.onKey) this.onKey(code, down);
    }

    /** Send one raw key event as recorded (replay): same as key(), named for intent */
    raw(code, down) { this.key(code, !!down); }

    /** Press a key for exactly one frame (edge-triggered keys: Force Push, active item) */
    tap(code) {
      if (this.held.has(code) || this.taps.includes(code)) return;
      this.B.input._simulate(code, true);
      this.taps.push(code);
      if (this.onKey) this.onKey(code, true);
    }

    releaseAll() {
      for (const code of [...this.held]) this.key(code, false);
      for (const code of this.taps) this.B.input._simulate(code, false);
      this.taps.length = 0;
    }

    /** Advance one 60 Hz simulation frame, exactly as the game's main loop does */
    step() {
      const B = this.B;
      if (this.host) this.host.beginFrame(this.frame);
      B.game.update(B.C.DT);
      B.input.endStep();
      this.frame++;
      if (this.taps.length) {
        for (const code of this.taps) { B.input._simulate(code, false); if (this.onKey) this.onKey(code, false); }
        this.taps.length = 0;
      }
    }

    /**
     * In-instance reset: fresh Game object, new run from `seed`.
     * opts: { depth (start floor), god (debug god mode) }
     */
    reset(seed, opts) {
      const o = opts || {};
      const B = this.B;
      this.releaseAll();
      // The key state lives in the game's input module, not here. Release every gameplay key regardless of
      // what this driver believes is held, so a reset is clean even if another driver used the instance before.
      for (const code of GAME_KEYS) B.input._simulate(code, false);
      B.input.endStep();
      this.frame = 0;
      if (this.host) { this.host.seedVisual(hashString(String(seed)) ^ 0x5bd1e995); this.host.beginFrame(0); }
      B.game = new B.Game();
      B.game.newRun(String(seed));
      if (o.depth && o.depth > 1) B.game.enterFloor(o.depth);
      if (o.god) B.debug.god(true);
    }
  }

  /** Map one agent decision (the four action heads) onto keys */
  function applyAction(sim, move, shoot, push, active) {
    const mv = MOVES[move];
    for (let i = 0; i < 4; i++) sim.key(MOVE_KEYS[i], mv.includes(MOVE_KEYS[i]));
    for (let i = 0; i < 4; i++) sim.key(SHOOT_KEYS[i], shoot === i + 1);
    if (push) sim.tap('KeyE');
    if (active) sim.tap('Space');
  }

  /** Random policy with its own seeded stream; one decision per call */
  function randomPolicy(seed) {
    const r = mulberry32(seed);
    return function act(sim) {
      applyAction(sim, Math.floor(r() * 9), Math.floor(r() * 5), r() < 0.02 ? 1 : 0, r() < 0.02 ? 1 : 0);
    };
  }

  /**
   * Run one scripted episode and return its signature. Used by the determinism checks in Node and in the browser.
   * spec: { seed, depth, god, frames, frameSkip, tourEvery }
   *   tourEvery > 0: every that many frames the player is teleported to the next room of the floor (debug hook),
   *   so one episode touches every room, the boss included.
   */
  function runEpisode(sim, spec) {
    const B = sim.B;
    const skip = spec.frameSkip || 4;
    const out = { seed: spec.seed, frames: 0, fault: null, enemies: [] };
    const seen = new Set();
    const h = new Hasher();
    try {
      sim.reset(spec.seed, { depth: spec.depth, god: spec.god });
      const act = randomPolicy(hashString(String(spec.seed)) ^ 0x2545f491);
      let tour = 0, f = 0;
      for (; f < spec.frames; f++) {
        const g = B.game;
        if (TERMINAL_STATES.includes(g.state)) break;
        if (g.state === 'play') {
          if (spec.tourEvery && f > 0 && f % spec.tourEvery === 0) {
            const cells = [...g.floor.cells.values()];
            g.teleport(cells[tour++ % cells.length].room);
          }
          if (f % skip === 0) act(sim);
        }
        sim.step();
        if (f % 30 === 0) {
          hashState(B, h);
          if (B.game.room) for (const e of B.game.room.enemies) seen.add(e.id);
        }
      }
      out.frames = f;
      hashState(B, h);
    } catch (err) {
      out.fault = String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
    }
    const g = B.game;
    out.sig = h.hex();
    out.endState = g.state;
    out.depth = g.depth;
    out.kills = g.runStats.kills;
    out.rooms = g.runStats.rooms;
    out.enemies = [...seen].sort();
    return out;
  }

  return { Sim, Hasher, hashState, hashString, mulberry32, applyAction, randomPolicy, runEpisode, MOVES, MOVE_KEYS, SHOOT_KEYS, TAP_KEYS, GAME_KEYS, ACTION_NVEC, TERMINAL_STATES };
});
