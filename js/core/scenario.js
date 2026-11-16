/*
 * scenario.js — what a reset sets up (R3): a full run from a seed, or a constructed test room.
 *
 * A scenario is a plain JSON object, so it can cross the bridge and be stored in a transcript.
 *
 *   { kind: 'full_run', seed, depth?, player?, endOn?, maxPlayFrames? }
 *   { kind: 'test_room', seed, depth?, layout?, enemies?, boss?, door?, player?, endOn?, maxPlayFrames? }
 *
 *   seed           string of A-Z, 0-9, '-' (1..32 chars), as the game's own seed dialog accepts
 *   depth          start floor, 1..99 (default 1)
 *   player         { items: [itemId], health, maxHealth, guardrails, credits, pushes, approvals, god }
 *                  health values are in half hearts, as in the game; anything left out keeps the game's default
 *   endOn          extra end conditions besides death: 'room_clear' (test_room only), 'boss_kill', 'floor_exit'
 *                  default: ['room_clear'] for a test room, [] for a full run
 *   maxPlayFrames  time limit in play frames (frames the agent can act in), 0 = none
 *
 *   test_room only:
 *   layout         'empty' (default), any layout id of the game, 'generated' (keep what the floor rolled for
 *                  that room, props included), or { rows: [7 strings of 13 chars from ".rbpse"] }
 *   enemies        ['bug', 'bug'] or [{ id: 'bug', count: 2 }]
 *   boss           a boss id instead of enemies: the room becomes a boss room (intro, boss bar, trapdoor)
 *   door           'up' | 'right' | 'down' | 'left': which door of the start room to use (default: first usable)
 *
 * How a test room is built (docs/phase0-results.md §6): the real floor is generated from the seed, an unvisited
 * normal room next to the start room is overwritten, and the player enters it through the door with
 * game.changeRoom(dir). populate(), door closing, spawn delay and the clear event then run through the game's own
 * code. BOTA.debug.spawn into the start room would skip all of that.
 *
 * No Node dependencies: CommonJS module in Node, global `BotaScenario` in a browser page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotaScenario = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ScenarioError extends Error {
    /** retryable: the scenario is valid but does not work with this seed; another seed may */
    constructor(message, retryable) { super(message); this.name = 'ScenarioError'; this.retryable = !!retryable; }
  }

  const KINDS = ['full_run', 'test_room'];
  const END_CONDITIONS = ['room_clear', 'boss_kill', 'floor_exit'];
  const DOOR_ORDER = ['up', 'right', 'down', 'left'];
  const SEED = /^[A-Z0-9-]{1,32}$/;
  const MAX_ENEMIES = 40;
  const MAX_HALVES = 24;   // the game's cap: 12 hearts in total

  const fail = (msg) => { throw new ScenarioError(msg); };
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const optInt = (obj, key, lo, hi) => {
    const v = obj[key];
    if (v === undefined || v === null) return null;
    if (!isInt(v, lo, hi)) fail(`player.${key} must be an integer in ${lo}..${hi}, got ${JSON.stringify(v)}`);
    return v;
  };

  /** Validate a scenario and fill in defaults. Needs no game. Throws ScenarioError. */
  function normalize(spec) {
    if (!spec || typeof spec !== 'object') fail('scenario must be an object');
    const known = ['kind', 'seed', 'depth', 'player', 'endOn', 'maxPlayFrames', 'layout', 'enemies', 'boss', 'door'];
    for (const k of Object.keys(spec)) if (!known.includes(k)) fail(`unknown scenario field "${k}"`);
    if (!KINDS.includes(spec.kind)) fail(`scenario.kind must be one of ${KINDS.join(', ')}`);
    const seed = String(spec.seed === undefined ? '' : spec.seed).toUpperCase();
    if (!SEED.test(seed)) fail(`scenario.seed must be 1..32 characters of A-Z, 0-9 or "-", got ${JSON.stringify(spec.seed)}`);
    const depth = spec.depth === undefined ? 1 : spec.depth;
    if (!isInt(depth, 1, 99)) fail('scenario.depth must be an integer in 1..99');
    const maxPlayFrames = spec.maxPlayFrames === undefined ? 0 : spec.maxPlayFrames;
    if (!isInt(maxPlayFrames, 0, 1e9)) fail('scenario.maxPlayFrames must be a non-negative integer');

    const pin = spec.player || {};
    if (typeof pin !== 'object') fail('scenario.player must be an object');
    for (const k of Object.keys(pin)) {
      if (!['items', 'health', 'maxHealth', 'guardrails', 'credits', 'pushes', 'approvals', 'god'].includes(k)) fail(`unknown player field "${k}"`);
    }
    const items = pin.items === undefined ? [] : pin.items;
    if (!Array.isArray(items) || items.some((id) => typeof id !== 'string')) fail('player.items must be a list of item ids');
    const player = {
      items: items.slice(),
      maxHealth: optInt(pin, 'maxHealth', 2, MAX_HALVES),
      health: optInt(pin, 'health', 1, MAX_HALVES),
      guardrails: optInt(pin, 'guardrails', 0, MAX_HALVES),
      credits: optInt(pin, 'credits', 0, 99),
      pushes: optInt(pin, 'pushes', 0, 99),
      approvals: optInt(pin, 'approvals', 0, 99),
      god: !!pin.god,
    };
    if (player.maxHealth !== null && player.maxHealth % 2) fail('player.maxHealth counts half hearts and must be even');

    const endOn = spec.endOn === undefined ? (spec.kind === 'test_room' ? ['room_clear'] : []) : spec.endOn;
    if (!Array.isArray(endOn) || endOn.some((c) => !END_CONDITIONS.includes(c))) fail(`scenario.endOn may contain: ${END_CONDITIONS.join(', ')}`);

    const out = { kind: spec.kind, seed, depth, player, endOn: [...new Set(endOn)], maxPlayFrames };
    if (spec.kind === 'full_run') {
      for (const k of ['layout', 'enemies', 'boss', 'door']) if (spec[k] !== undefined) fail(`scenario.${k} is only valid for a test_room`);
      if (out.endOn.includes('room_clear')) fail('endOn "room_clear" is only valid for a test_room');
      return out;
    }

    // test_room
    let layout = spec.layout === undefined || spec.layout === null ? 'empty' : spec.layout;
    if (typeof layout === 'object') {
      const rows = layout.rows;
      if (!Array.isArray(rows) || rows.length !== 7 || rows.some((r) => typeof r !== 'string' || r.length !== 13 || /[^.rbpse]/.test(r))) {
        fail('layout.rows must be 7 strings of 13 characters from ".rbpse"');
      }
      layout = { rows: rows.slice() };
    } else if (typeof layout !== 'string') fail('scenario.layout must be a layout id, "generated" or { rows }');
    const enemies = [];
    if (spec.enemies !== undefined && !Array.isArray(spec.enemies)) fail('scenario.enemies must be a list');
    for (const entry of spec.enemies === undefined ? [] : spec.enemies) {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      const count = typeof entry === 'string' ? 1 : entry && entry.count === undefined ? 1 : entry && entry.count;
      if (typeof id !== 'string' || !isInt(count, 1, MAX_ENEMIES)) fail('scenario.enemies entries must be an enemy id or { id, count }');
      for (let i = 0; i < count; i++) enemies.push(id);
    }
    if (enemies.length > MAX_ENEMIES) fail(`a test room holds at most ${MAX_ENEMIES} enemies`);
    const boss = spec.boss === undefined || spec.boss === null ? null : spec.boss;
    if (boss !== null && typeof boss !== 'string') fail('scenario.boss must be a boss id');
    if (boss !== null && enemies.length) fail('a test room takes either enemies or a boss, not both');
    if (layout === 'generated' && boss !== null) fail('a boss test room needs an explicit layout (the default "empty" works)');
    const door = spec.door === undefined || spec.door === null ? null : spec.door;
    if (door !== null && !DOOR_ORDER.includes(door)) fail(`scenario.door must be one of ${DOOR_ORDER.join(', ')}`);
    if (out.endOn.includes('room_clear') && !enemies.length && boss === null) {
      fail('endOn "room_clear" needs enemies or a boss: an empty room counts as cleared the moment it is entered');
    }
    return Object.assign(out, { layout, enemies, boss, door });
  }

  function setupPlayer(B, sc) {
    const g = B.game, p = g.player, P = sc.player;
    for (const id of P.items) {
      if (!B.ITEMS[id]) fail(`unknown item id "${id}"`);
      p.giveItem(id, g);
    }
    if (P.maxHealth !== null) { p.maxHealth = P.maxHealth; p.health = Math.min(p.health, p.maxHealth); if (P.health === null) p.health = p.maxHealth; }
    if (P.health !== null) {
      if (P.health > p.maxHealth) fail(`player.health ${P.health} exceeds maxHealth ${p.maxHealth}`);
      p.health = P.health;
    }
    if (P.guardrails !== null) {
      if (P.guardrails > MAX_HALVES - p.maxHealth) fail(`player.guardrails ${P.guardrails} does not fit next to maxHealth ${p.maxHealth}`);
      p.guardrails = P.guardrails;
    }
    if (P.credits !== null) p.credits = P.credits;
    if (P.pushes !== null) p.pushes = P.pushes;
    if (P.approvals !== null) p.approvals = P.approvals;
    p.god = P.god;
    p.recalcStats();
  }

  function resolveLayout(B, sc) {
    if (sc.layout === 'generated') return null;
    if (typeof sc.layout === 'string') {
      const found = B.LAYOUTS.find((l) => l.id === sc.layout);
      if (!found) fail(`unknown layout id "${sc.layout}"`);
      if (sc.boss !== null && !found.tags.includes('special')) fail(`layout "${sc.layout}" is not an open arena; a boss room needs a layout tagged "special"`);
      return found;
    }
    const layout = { id: 'custom', tags: [sc.boss !== null ? 'special' : 'normal'], weight: 1, rows: sc.layout.rows, bias: null };
    const check = B.validateLayout(layout, { strict: true });
    if (!check.ok) fail(`custom layout rejected by the game's validateLayout: ${check.error}`);
    return layout;
  }

  /**
   * Build the scenario in a game that has just started a fresh run on the scenario's floor
   * (Sim.reset(seed, { depth })). Returns { targetRoom, entryDir, startDepth }.
   */
  function build(B, sc) {
    const g = B.game;
    const ctx = { targetRoom: null, entryDir: null, startDepth: g.depth };
    setupPlayer(B, sc);
    if (sc.kind === 'full_run') return ctx;

    for (const id of sc.enemies) if (!B.ENEMIES[id]) fail(`unknown enemy id "${id}"`);
    if (sc.boss !== null && !B.BOSSES[sc.boss]) fail(`unknown boss id "${sc.boss}"`);
    const layout = resolveLayout(B, sc);

    const start = g.room;
    const usable = (dir) => {
      const d = start.doors[dir];
      return !!d && !d.edge.hidden && !d.edge.locked && d.target.room.type === 'normal' && !d.target.room.visited;
    };
    const dir = (sc.door ? [sc.door] : DOOR_ORDER).find(usable);
    if (!dir) {
      throw new ScenarioError(`seed ${sc.seed}, floor ${sc.depth}: the start room has no unlocked normal room${sc.door ? ' behind its ' + sc.door + ' door' : ' next to it'}; use another seed`, true);
    }
    const cell = start.doors[dir].target;
    const room = cell.room;
    if (layout) { room.stampLayout(layout); room.props.clear(); }
    room.plannedEnemies = sc.enemies.slice();
    room.looseLoot = [];
    room.hasReadme = false;
    room.hasPipe = false;
    room.guaranteedKey = false;
    room.encounterBoss = null;
    if (g.floor.readmeRoom === cell) g.floor.readmeRoom = null;
    if (g.floor.keyRoom === cell) g.floor.keyRoom = null;
    if (sc.boss !== null) { room.type = 'boss'; room.bossId = sc.boss; room.plannedEnemies = []; }

    g.changeRoom(dir);
    ctx.targetRoom = room;
    ctx.entryDir = dir;
    return ctx;
  }

  return { normalize, build, ScenarioError, KINDS, END_CONDITIONS, DOOR_ORDER };
});
