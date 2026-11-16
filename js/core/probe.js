/*
 * probe.js — raw state probe. PRIVILEGED: for reward shaping, curriculum, debugging and tests.
 *
 * Everything here reads internal game state without regard to what is on screen. It must never be fed to the
 * model (REQUIREMENTS §3.3); the fair observation is a separate module with its own allowlist.
 *
 * Two forms:
 *   write(B, out, offset)  fixed vector of numbers in the order of NAMES, cheap enough for every decision
 *   snapshot(B)            a JSON object with more detail, for debugging and tests
 *
 * No Node dependencies: CommonJS module in Node, global `BotaProbe` in a browser page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotaProbe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROOM_TYPES = ['start', 'normal', 'boss', 'treasure', 'shop', 'secret', 'terms', 'encounter'];

  // Order is part of the bridge format: append, never reorder.
  const FIELDS = [
    ['player_x', (g, p) => p.x],
    ['player_y', (g, p) => p.y],
    ['health', (g, p) => p.health],                 // half hearts
    ['max_health', (g, p) => p.maxHealth],
    ['guardrails', (g, p) => p.guardrails],
    ['credits', (g, p) => p.credits],
    ['pushes', (g, p) => p.pushes],
    ['approvals', (g, p) => p.approvals],
    ['items', (g, p) => p.items.length],
    ['active_charge', (g, p) => (p.active ? p.active.charge : -1)],   // -1: no active item
    ['depth', (g) => g.depth],
    ['room_x', (g, p, r) => r.cell.x],
    ['room_y', (g, p, r) => r.cell.y],
    ['room_type', (g, p, r) => ROOM_TYPES.indexOf(r.type)],          // index into ROOM_TYPES, -1 unknown
    ['room_cleared', (g, p, r) => (r.cleared ? 1 : 0)],
    ['doors_closed', (g, p, r) => (r.combatClosed ? 1 : 0)],
    ['enemies_alive', (g, p, r, s) => s.alive],
    ['enemy_hp', (g, p, r, s) => s.hp],                              // sum over living enemies
    ['boss_hp', (g, p, r, s) => s.bossHp],                           // sum over living boss entities
    ['boss_hp_max', (g, p, r, s) => s.bossMax],
    ['projectiles', (g, p, r) => r.projectiles.length],
    ['pickups', (g, p, r) => r.pickups.length],
    ['rooms_visited', (g) => g.runStats.rooms],
    ['kills_total', (g) => g.runStats.kills],
    ['run_time', (g) => g.runStats.time],                            // seconds of play
    ['score', (g) => g.scoreTotal()],
  ];
  const NAMES = FIELDS.map((f) => f[0]);
  const scratch = { alive: 0, hp: 0, bossHp: 0, bossMax: 0 };

  function enemyStats(room) {
    const s = scratch;
    s.alive = s.hp = s.bossHp = s.bossMax = 0;
    for (const e of room.enemies) {
      if (e.dead) continue;
      if (e.isBoss) { s.bossHp += Math.max(0, e.hp); s.bossMax += e.maxHp; }
      if (e.ignoreForClear) continue;
      s.alive++;
      s.hp += Math.max(0, e.hp);
    }
    return s;
  }

  /** Write the probe vector into `out` (any numeric array) starting at `offset` */
  function write(B, out, offset) {
    const g = B.game, p = g.player, r = g.room;
    const s = enemyStats(r);
    for (let i = 0; i < FIELDS.length; i++) {
      const v = FIELDS[i][1](g, p, r, s);
      out[offset + i] = typeof v === 'number' && v === v ? v : 0;
    }
  }

  /** Detailed, JSON-safe view of the current state */
  function snapshot(B) {
    const g = B.game, p = g.player, r = g.room;
    const vec = new Array(FIELDS.length);
    write(B, vec, 0);
    const out = { state: g.state, seed: g.seed, probe: {} };
    NAMES.forEach((n, i) => { out.probe[n] = vec[i]; });
    out.player = {
      x: p.x, y: p.y, health: p.health, maxHealth: p.maxHealth, guardrails: p.guardrails,
      credits: p.credits, pushes: p.pushes, approvals: p.approvals, god: !!p.god, dead: !!p.dead,
      items: p.items.slice(), active: p.active ? { id: p.active.id, charge: p.active.charge } : null,
    };
    out.room = {
      x: r.cell.x, y: r.cell.y, type: r.type, cleared: !!r.cleared, doorsClosed: !!r.combatClosed, bossId: r.bossId || null,
      doors: Object.keys(r.doors).filter((d) => r.doors[d]),
      enemies: r.enemies.map((e) => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, dead: !!e.dead, boss: !!e.isBoss })),
      projectiles: r.projectiles.length,
      pickups: r.pickups.map((q) => ({ type: q.type || null, item: q.itemId || null, x: q.x, y: q.y })),
    };
    out.floor = { depth: g.depth, rooms: g.floor ? g.floor.cells.size : 0 };
    return out;
  }

  return { NAMES, ROOM_TYPES, write, snapshot };
});
