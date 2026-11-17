/*
 * observe.js — the fair observation, version 1 (REQUIREMENTS §3.3, R7–R9). Spec: docs/observation-spec.md.
 *
 * HARD RULE: the model never receives state a human player could not see on screen at that moment.
 * This file is therefore an ALLOWLIST. Every value it writes is produced by an explicit extractor that names the
 * place in the game's renderer where the value becomes visible (src/render/renderer.js, src/render/hud.js, the
 * entity's own draw method). Nothing is copied from game state by default and filtered afterwards.
 *
 * Review gate: every thing in the room must have a reviewed view, i.e. an entry below that says what it shows.
 * Anything else (an enemy id, projectile class, pickup class, prop kind, familiar, sprite) is reported by
 * write() as "unreviewed"; the environment then ends the episode instead of showing the model something
 * nobody has checked, or hiding something a human would see.
 *
 * Kinematics are differences of displayed positions between the last two frames, never the engine's vx/vy.
 *
 * Deliberately NOT observed (a human sees them, the model does not; safe, but a known gap):
 *   the crack that hints at a hidden door, banners, the item held overhead after a pickup, floating enemy text,
 *   projectile colour, particle effects, the passive item list (only on the pause screen, which the agent
 *   cannot open).
 *
 * No Node dependencies: CommonJS module in Node, global `BotaObserve` in a browser page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotaObserve = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ID = 'v1';
  const VERSION = 1;
  const FPS = 60;

  // ---- vocabularies (frozen for version 1; index 0 always means "none") -------------------------------------
  // Entity types are the names of the sprites the game draws, so "type" is what is on screen by construction.
  const SPRITES = [
    'enemy_bug', 'enemy_null_pointer', 'enemy_memory_leak', 'enemy_leaklet',
    'shot_player', 'shot_enemy', 'bomb',
    'pickup_heart_half', 'pickup_heart', 'pickup_guardrail', 'pickup_credit', 'pickup_credit5', 'pickup_push',
    'pickup_push2', 'pickup_approval', 'pickup_chest', 'pickup_readme', 'pickup_chest_locked', 'pickup_chest_open',
    'trapdoor', 'pipe',
  ];
  const DOOR_KINDS = ['normal', 'boss', 'treasure', 'shop', 'terms', 'secret'];
  const DOOR_DIRS = ['up', 'right', 'down', 'left'];
  const PROP_KINDS = ['crate', 'bush', 'package', 'carton', 'sandcastle'];
  const ACTIVE_ITEMS = ['regenerate_response', 'stop_generating', 'rm_rf', 'compact', 'ctrl_z'];
  const BOSSES = ['monolith', 'stakeholder', 'friday_deploy', 'infinite_loop', 'rogue_swarm', 'agent_swarm', 'reviewer',
    'octopus_merge', 'nested_loop', 'megalith', 'shareholder', 'memory_hog', 'ransomware', 'system_prompt'];
  const MAP_ICONS = ['boss', 'treasure', 'shop', 'secret', 'terms'];
  const SCAN_TYPES = ['boss', 'secret'];
  const TILE_CLASSES = ['floor', 'wall', 'rock', 'block', 'pit', 'spikes', 'door', 'prop', 'cactus'];
  const FACINGS = ['up', 'down', 'left', 'right'];

  // ---- reviewed enemies ---------------------------------------------------------------------------------------
  // "body" = everything the enemy shows is what AI.drawBody draws (src/entities/enemy.js): its sprite at its
  // position, flipped when moving left, faded in while spawning, scaled, flashing when hit, with a frost shimmer
  // when frozen, plus the shadow the renderer puts under it. The review of each is in docs/observation-spec.md.
  // create() checks against the loaded game that the behaviour still has no drawing hooks of its own.
  const ENEMIES = {
    bug: { sprite: 'enemy_bug', behavior: 'wander' },
    null_pointer: { sprite: 'enemy_null_pointer', behavior: 'fly_chase' },
    memory_leak: { sprite: 'enemy_memory_leak', behavior: 'split' },
    leaklet: { sprite: 'enemy_leaklet', behavior: 'chase' },
  };

  // ---- layout -------------------------------------------------------------------------------------------------
  const CAP = { enemies: 32, shots: 96, pickups: 16 };
  const MAP_W = 7, MAP_H = 5;      // the minimap window, as in hud.js
  const COLS = 15, ROWS = 9;

  const PLAYER = ['x', 'y', 'vx', 'vy', 'fresh', 'facing', 'invulnerable', 'floating',
    'hearts_visible', 'health', 'max_health', 'guardrails',
    'credits', 'pushes', 'approvals',
    'stats_visible', 'damage', 'fire_rate', 'speed', 'range', 'shot_speed', 'luck',
    'active_visible', 'active_item', 'active_charge', 'active_max',
    'lock_active', 'lock_pushes', 'lock_fire'];
  const HUD = ['depth', 'clock', 'minimap_visible', 'boss_bar', 'boss_type', 'boss_ratio', 'boss_side_quest',
    'enemies_total', 'shots_total', 'pickups_total'];
  const ENEMY = ['type', 'x', 'y', 'vx', 'vy', 'fresh', 'r', 'scale', 'alpha', 'flip', 'flash', 'frozen', 'flying', 'hp_shown', 'hp_ratio'];
  const SHOT = ['type', 'x', 'y', 'vx', 'vy', 'fresh', 'r', 'urgent'];
  const PICKUP = ['type', 'x', 'y', 'vx', 'vy', 'fresh', 'r', 'alpha', 'price'];
  const DOOR = ['present', 'kind', 'locked', 'closed'];
  const MINIMAP = ['state', 'icon', 'link_up', 'link_right', 'link_down', 'link_left', 'scan', 'scan_edge'];

  // Order matters only inside each dtype group; floats come first so every float field is 4-byte aligned.
  const FIELDS = [
    { name: 'player', dtype: 'f4', shape: [PLAYER.length], columns: PLAYER },
    { name: 'hud', dtype: 'f4', shape: [HUD.length], columns: HUD },
    { name: 'enemies', dtype: 'f4', shape: [CAP.enemies, ENEMY.length], columns: ENEMY },
    { name: 'shots', dtype: 'f4', shape: [CAP.shots, SHOT.length], columns: SHOT },
    { name: 'pickups', dtype: 'f4', shape: [CAP.pickups, PICKUP.length], columns: PICKUP },
    { name: 'tiles', dtype: 'u1', shape: [ROWS, COLS] },
    { name: 'tile_prop', dtype: 'u1', shape: [ROWS, COLS] },
    { name: 'tile_damaged', dtype: 'u1', shape: [ROWS, COLS] },
    { name: 'doors', dtype: 'u1', shape: [4, DOOR.length], columns: DOOR },
    { name: 'minimap', dtype: 'u1', shape: [MAP_H, MAP_W, MINIMAP.length], columns: MINIMAP },
    { name: 'enemy_mask', dtype: 'u1', shape: [CAP.enemies] },
    { name: 'shot_mask', dtype: 'u1', shape: [CAP.shots] },
    { name: 'pickup_mask', dtype: 'u1', shape: [CAP.pickups] },
  ];
  const SIZE = { f4: 4, u1: 1 };
  let BYTES = 0;
  for (const f of FIELDS) {
    f.count = f.shape.reduce((a, b) => a * b, 1);
    f.offset = BYTES;
    BYTES += f.count * SIZE[f.dtype];
  }
  BYTES = (BYTES + 3) & ~3;

  const LAYOUT = {
    id: ID, version: VERSION, bytes: BYTES,
    fields: FIELDS.map((f) => ({ name: f.name, dtype: f.dtype, shape: f.shape, offset: f.offset, columns: f.columns || null })),
    vocab: {
      sprites: SPRITES, door_kinds: DOOR_KINDS, door_dirs: DOOR_DIRS, prop_kinds: PROP_KINDS, active_items: ACTIVE_ITEMS,
      bosses: BOSSES, map_icons: MAP_ICONS, scan_types: SCAN_TYPES, tile_classes: TILE_CLASSES, facings: FACINGS,
      map_states: ['none', 'seen', 'visited', 'current'],
    },
    reviewed: { enemies: Object.keys(ENEMIES), projectiles: ['Projectile', 'Bomb'], pickups: ['Pickup', 'Trapdoor', 'Pipe'], props: PROP_KINDS, familiars: [] },
    units: 'positions in room pixels (960 x 576, origin top left), velocities in pixels per second, health in half hearts',
  };

  const index1 = (list, name) => list.indexOf(name) + 1;   // 0 = not in the vocabulary
  // The same lookups, prepared for the per-decision path
  const SPRITE_INDEX = new Map(SPRITES.map((n, i) => [n, i + 1]));
  const ENEMY_VIEW = new Map(Object.keys(ENEMIES).map((id) => [id, { sprite: ENEMIES[id].sprite, type: SPRITES.indexOf(ENEMIES[id].sprite) + 1 }]));
  const T_BOMB = SPRITES.indexOf('bomb') + 1, T_SHOT_PLAYER = SPRITES.indexOf('shot_player') + 1, T_SHOT_ENEMY = SPRITES.indexOf('shot_enemy') + 1;
  const T_TRAPDOOR = SPRITES.indexOf('trapdoor') + 1, T_PIPE = SPRITES.indexOf('pipe') + 1, T_CHEST_OPEN = SPRITES.indexOf('pickup_chest_open') + 1;
  const col = (names) => { const o = {}; names.forEach((n, i) => { o[n] = i; }); return o; };
  const P = col(PLAYER), H = col(HUD), E = col(ENEMY), S = col(SHOT), K = col(PICKUP), D = col(DOOR), M = col(MINIMAP);
  // door directions in DOOR_DIRS order: minimap link column of that side, of the opposite side, and the step
  const LINK = DOOR_DIRS.map((d) => M['link_' + d]);
  const LINK_BACK = [M.link_down, M.link_left, M.link_up, M.link_right];
  const STEP_X = [0, 1, 0, -1], STEP_Y = [-1, 0, 1, 0];

  // Sort keys are derived from the screen only: distance to the player's sprite, then position.
  let sortX = 0, sortY = 0;
  function byDistance(a, b) {
    const da = (a.x - sortX) * (a.x - sortX) + (a.y - sortY) * (a.y - sortY);
    const db = (b.x - sortX) * (b.x - sortX) + (b.y - sortY) * (b.y - sortY);
    return da - db || a.y - b.y || a.x - b.x;
  }

  /** Check that the loaded game is the one these views were reviewed against. Throws otherwise. */
  function verifyGame(B) {
    const problems = [];
    for (const id of Object.keys(ENEMIES)) {
      const def = B.ENEMIES[id], want = ENEMIES[id];
      if (!def) { problems.push(`enemy "${id}" does not exist`); continue; }
      if (def.sprite !== want.sprite) problems.push(`enemy "${id}" draws "${def.sprite}", reviewed as "${want.sprite}"`);
      if (def.behavior !== want.behavior) problems.push(`enemy "${id}" has behaviour "${def.behavior}", reviewed as "${want.behavior}"`);
      const beh = B.BEHAVIORS[def.behavior];
      if (!beh || beh.draw || beh.drawUnder || beh.drawOver) problems.push(`behaviour "${def.behavior}" of "${id}" draws something of its own that was not reviewed`);
    }
    for (const type of Object.keys(B.PICKUP_TYPES)) {
      if (!SPRITES.includes(B.PICKUP_TYPES[type].sprite)) problems.push(`pickup type "${type}" draws "${B.PICKUP_TYPES[type].sprite}", which is not in the vocabulary`);
    }
    for (const id of ACTIVE_ITEMS) if (!B.ITEMS[id] || !B.ITEMS[id].active) problems.push(`active item "${id}" does not exist`);
    for (const id of Object.keys(B.ITEMS)) if (B.ITEMS[id].active && !ACTIVE_ITEMS.includes(id)) problems.push(`active item "${id}" is not in the vocabulary`);
    for (const id of Object.keys(B.BOSSES)) if (!BOSSES.includes(id)) problems.push(`boss "${id}" is not in the vocabulary`);
    for (const k of Object.keys(B.PROP_KINDS || {})) if (!PROP_KINDS.includes(k)) problems.push(`prop kind "${k}" is not in the vocabulary`);
    const T = B.TILES;
    TILE_CLASSES.forEach((name, i) => { if (T[name.toUpperCase()] !== i) problems.push(`tile class "${name}" is not ${i}`); });
    if (B.C.COLS !== COLS || B.C.ROWS !== ROWS) problems.push('room size differs');
    if (problems.length) throw new Error(`[observe ${ID}] the game differs from the reviewed version: ${problems.join('; ')}`);
  }

  class Observer {
    /** buffer/byteOffset: where to write (default: own memory). byteOffset must be a multiple of 4. */
    constructor(buffer, byteOffset) {
      this.layout = LAYOUT;
      this.bytes = BYTES;
      this.verified = new WeakSet();
      // Positions as displayed one frame before the observation (mark()), for the velocity fields
      this.prev = new Map();
      this.prevX = new Float64Array(512);
      this.prevY = new Float64Array(512);
      this.prevRoom = null;
      this.lists = { enemies: [], shots: [], pickups: [] };
      this.missing = null;                                  // unreviewed things found by the current write()
      this.statIn = new Float64Array(4).fill(NaN);          // stats as last printed: toFixed is not free
      this.statOut = new Float64Array(4);
      this.bind(buffer || new ArrayBuffer(BYTES), byteOffset || 0);
    }

    bind(buffer, byteOffset) {
      if (byteOffset % 4) throw new RangeError('observation buffers must be 4-byte aligned');
      this.buffer = buffer;
      this.byteOffset = byteOffset;
      this.raw = new Uint8Array(buffer, byteOffset, BYTES);
      this.f = {};
      for (const fd of FIELDS) {
        this.f[fd.name] = fd.dtype === 'f4' ? new Float32Array(buffer, byteOffset + fd.offset, fd.count) : new Uint8Array(buffer, byteOffset + fd.offset, fd.count);
      }
    }

    /** Forget remembered positions (new episode) */
    reset() { this.prev.clear(); this.prevRoom = null; }

    /** All zeros: used when the game state cannot be read (after a fault) */
    blank() { this.raw.fill(0); }

    /**
     * Remember where everything is drawn right now. The environment calls this before the last frame of a
     * decision; write() then reports the displacement over that one frame as velocity.
     */
    mark(B) {
      const g = B.game, room = g.room, prev = this.prev, xs = this.prevX, ys = this.prevY, cap = xs.length;
      prev.clear();
      this.prevRoom = room;
      if (!room) return;
      let n = 0;
      const p = g.player;
      if (p) { prev.set(p, n); xs[n] = p.x; ys[n] = p.y; n++; }
      for (const list of [room.enemies, room.projectiles, room.pickups]) {
        for (let i = 0; i < list.length && n < cap; i++) { const o = list[i]; prev.set(o, n); xs[n] = o.x; ys[n] = o.y; n++; }
      }
    }

    _flag(what) {
      if (!this.missing) this.missing = [];
      if (!this.missing.includes(what)) this.missing.push(what);
    }

    /** A stat as the HUD prints it (two decimals), cached on its input */
    _printed(slot, value) {
      if (this.statIn[slot] !== value) { this.statIn[slot] = value; this.statOut[slot] = +value.toFixed(2); }
      return this.statOut[slot];
    }

    /** Write x, y, vx, vy, fresh at `at` of `out` for the thing `o` */
    _kin(out, at, o, sameRoom) {
      out[at + 1] = o.x;
      out[at + 2] = o.y;
      const i = sameRoom ? this.prev.get(o) : undefined;
      if (i === undefined) { out[at + 3] = 0; out[at + 4] = 0; out[at + 5] = 1; return; }
      out[at + 3] = (o.x - this.prevX[i]) * FPS;
      out[at + 4] = (o.y - this.prevY[i]) * FPS;
      out[at + 5] = 0;
    }

    /**
     * Write the observation of the current frame. Returns null, or the list of things in the room that have no
     * reviewed view (they are left out of the observation; the caller must end the episode).
     */
    write(B) {
      if (!this.verified.has(B)) { verifyGame(B); this.verified.add(B); }
      const g = B.game, room = g.room, p = g.player;
      this.raw.fill(0);
      if (!room || !p) return ['game:no room'];
      this.missing = null;
      const sameRoom = this.prevRoom === room;
      const f = this.f;
      const glitch = g.hudGlitch && g.hudGlitch.t > 0 ? g.hudGlitch.kind : null;   // hud.js glitchFor; masked for the whole duration

      // ---- room: tiles and doors (renderer.js bakeBackground, drawObstacle, drawProps, drawDoor) ----
      const T = B.TILES, tiles = f.tiles;
      tiles.set(room.tiles);
      for (let d = 0; d < 4; d++) {
        const dir = DOOR_DIRS[d], door = room.doors[dir], dt = B.C.DOOR_TILES[dir];
        const ti = dt.row * COLS + dt.col;
        if (!door || door.edge.hidden) { tiles[ti] = T.WALL; continue; }   // a hidden door is drawn as wall
        tiles[ti] = T.DOOR;
        const at = d * DOOR.length;
        f.doors[at + D.present] = 1;
        f.doors[at + D.kind] = index1(DOOR_KINDS, door.edge.kind) || 1;   // unknown kinds are drawn in the normal style
        f.doors[at + D.locked] = door.edge.locked ? 1 : 0;                // padlock and chain
        f.doors[at + D.closed] = door.edge.locked || room.combatClosed ? 1 : 0;   // door leaves shut
      }
      if (room.props.size) for (const [key, pr] of room.props) {
        const comma = key.indexOf(',');
        const c = +key.slice(0, comma), r = +key.slice(comma + 1);
        if (room.tileAt(c, r) !== T.PROP) continue;           // drawProps skips these too
        const kind = index1(PROP_KINDS, pr.kind);
        if (!kind) { this._flag(`prop:${pr.kind}`); tiles[r * COLS + c] = T.FLOOR; continue; }
        f.tile_prop[r * COLS + c] = kind;                     // sprite prop_<kind>
        f.tile_damaged[r * COLS + c] = pr.hp < pr.max * 0.5 ? 1 : 0;   // sprite frame 1
      }

      // ---- player (player.js draw) ----
      const pl = f.player;
      this._kin(pl, P.x - 1, p, sameRoom);
      pl[P.facing] = Math.max(0, FACINGS.indexOf(p.facing));
      pl[P.invulnerable] = p.invuln > 0 ? 1 : 0;     // the sprite blinks
      pl[P.floating] = p.floating ? 1 : 0;           // drawn hovering above its shadow

      // ---- HUD bar (hud.js draw) ----
      if (glitch !== 'hearts') {                     // drawHearts
        pl[P.hearts_visible] = 1;
        pl[P.health] = p.health; pl[P.max_health] = p.maxHealth; pl[P.guardrails] = p.guardrails;
      }
      pl[P.credits] = p.credits; pl[P.pushes] = p.pushes; pl[P.approvals] = p.approvals;   // drawCounter, never glitched
      if (glitch !== 'stats') {                      // drawStats, with the rounding it prints
        const s = p.stats;
        pl[P.stats_visible] = 1;
        pl[P.damage] = this._printed(0, s.damage);
        pl[P.fire_rate] = this._printed(1, 1 / s.fireDelay);
        pl[P.speed] = this._printed(2, s.speed);
        pl[P.range] = Math.round(s.range);
        pl[P.shot_speed] = this._printed(3, s.shotSpeed);
        pl[P.luck] = Math.round(s.luck);
      }
      if (glitch !== 'items') {                      // drawActive
        pl[P.active_visible] = 1;
        if (p.active) {
          const def = B.ITEMS[p.active.id];
          const type = index1(ACTIVE_ITEMS, p.active.id);
          if (!type || !def) this._flag(`active:${p.active.id}`);
          else {
            const max = Math.max(1, def.maxCharge || 1);
            pl[P.active_item] = type;
            pl[P.active_max] = max;
            pl[P.active_charge] = Math.min(max, p.active.charge);
          }
        }
      }
      const enc = p.encrypted || {};                 // drawEncrypted: stamps over the locked areas
      pl[P.lock_active] = enc.active ? 1 : 0; pl[P.lock_pushes] = enc.pushes ? 1 : 0; pl[P.lock_fire] = enc.fire ? 1 : 0;

      const hud = f.hud;
      hud[H.depth] = g.depth;                                              // drawFloorLabel "FLOOR n"
      hud[H.clock] = Math.floor((g.runStats && g.runStats.time) || 0);     // drawFloorLabel mm:ss

      // ---- boss bar (hud.js drawBossBar) ----
      let boss = null;
      for (const e of room.enemies) if (e.isBoss && !e.dead) { boss = e; break; }
      if (boss && g.state !== 'bossIntro') {
        const group = boss.bossGroup || [boss];
        let hpSum = 0, maxSum = 0;
        for (const m of group) { maxSum += m.maxHp; if (!m.dead) hpSum += Math.max(0, m.hp); }
        hud[H.boss_bar] = 1;
        hud[H.boss_ratio] = Math.max(0, Math.min(1, hpSum / Math.max(1, maxSum)));
        hud[H.boss_type] = index1(BOSSES, boss.id);            // the name printed above the bar
        hud[H.boss_side_quest] = boss.encounter ? 1 : 0;       // "SIDE QUEST:" prefix
      }

      // ---- minimap (hud.js drawMinimap, scanMarks) ----
      if (glitch !== 'minimap' && g.floor) {
        hud[H.minimap_visible] = 1;
        this._minimap(B, f.minimap);
      }

      // ---- enemies (renderer.js drawRoom, enemy.js Enemy.draw / AI.drawBody / drawHpBar) ----
      sortX = p.x; sortY = p.y;
      const showHp = !!(p.flags && p.flags.showHp);
      const enemies = this.lists.enemies; enemies.length = 0;
      for (const e of room.enemies) {
        if (e.dead) continue;
        const view = ENEMY_VIEW.get(e.id);
        if (!view || e.isBoss || (e.spriteName && e.spriteName !== view.sprite)) { this._flag(`enemy:${e.id}`); continue; }
        if (e.alpha <= 0 && e.noShadow) continue;   // fully transparent and without a shadow: nothing of it is on screen
        enemies.push(e);
      }
      if (enemies.length > 1) enemies.sort(byDistance);
      hud[H.enemies_total] = enemies.length;
      for (let n = 0; n < enemies.length && n < CAP.enemies; n++) {
        const e = enemies[n], at = n * ENEMY.length, out = f.enemies;
        f.enemy_mask[n] = 1;
        out[at + E.type] = ENEMY_VIEW.get(e.id).type;
        this._kin(out, at, e, sameRoom);
        out[at + E.r] = e.r;                                                 // shadow size (drawShadow)
        out[at + E.scale] = e.scale * (e.sizeMult || 1);
        const appear = e.spawnDelay > 0 ? 1 - e.spawnDelay / 0.5 : 1;        // fades in while it wakes up
        out[at + E.alpha] = e.alpha * Math.max(0, Math.min(1, 0.3 + 0.7 * appear));
        out[at + E.flip] = !e.def.noFlip && e.vx < -5 ? 1 : 0;               // the sprite is mirrored
        out[at + E.flash] = e.flash > 0 ? 1 : 0;
        out[at + E.frozen] = e.frozen > 0 ? 1 : 0;                           // frost shimmer
        out[at + E.flying] = e.flying && !e.noShadow ? 1 : 0;                // shadow drawn lower
        if (showHp && !e.noHpBar && !e.proxy) {                              // Code Review item: drawHpBar
          out[at + E.hp_shown] = 1;
          out[at + E.hp_ratio] = Math.max(0, e.hp / e.maxHp);
        }
      }

      // ---- projectiles and bombs (projectile.js draw) ----
      const shots = this.lists.shots; shots.length = 0;
      for (const q of room.projectiles) {
        if (q.dead) continue;
        if (q instanceof B.Bomb) { shots.push(q); continue; }
        if (q.constructor !== B.Projectile) { this._flag(`projectile:${q.constructor && q.constructor.name}`); continue; }
        if (q.sprite && B.hasSprite(q.sprite) && !SPRITE_INDEX.has(q.sprite)) { this._flag(`projectile sprite:${q.sprite}`); continue; }
        shots.push(q);
      }
      if (shots.length > 1) shots.sort(byDistance);
      hud[H.shots_total] = shots.length;
      for (let n = 0; n < shots.length && n < CAP.shots; n++) {
        const q = shots[n], at = n * SHOT.length, out = f.shots;
        f.shot_mask[n] = 1;
        this._kin(out, at, q, sameRoom);
        if (q instanceof B.Bomb) {
          out[at + S.type] = T_BOMB;
          out[at + S.r] = 16;
          out[at + S.urgent] = q.fuse < 0.6 ? 1 : 0;                         // it blinks faster
        } else {
          out[at + S.type] = q.sprite && B.hasSprite(q.sprite) ? SPRITE_INDEX.get(q.sprite) : q.team === 'enemy' ? T_SHOT_ENEMY : T_SHOT_PLAYER;
          out[at + S.r] = q.r;
        }
      }

      // ---- things on the floor (pickup.js draw methods) ----
      const pickups = this.lists.pickups; pickups.length = 0;
      for (const q of room.pickups) {
        if (q.dead) continue;
        const c = q.constructor;
        if (c !== B.Pickup && c !== B.Trapdoor && c !== B.Pipe) { this._flag(`pickup:${c && c.name}`); continue; }
        if (c === B.Pickup && !q.opened && !SPRITE_INDEX.has(q.def.sprite)) { this._flag(`pickup sprite:${q.def.sprite}`); continue; }
        pickups.push(q);
      }
      if (pickups.length > 1) pickups.sort(byDistance);
      hud[H.pickups_total] = pickups.length;
      for (let n = 0; n < pickups.length && n < CAP.pickups; n++) {
        const q = pickups[n], at = n * PICKUP.length, out = f.pickups, c = q.constructor;
        f.pickup_mask[n] = 1;
        this._kin(out, at, q, sameRoom);
        out[at + K.r] = q.r;
        out[at + K.alpha] = 1;
        if (c === B.Trapdoor) out[at + K.type] = T_TRAPDOOR;
        else if (c === B.Pipe) { out[at + K.type] = T_PIPE; out[at + K.alpha] = q.armT > 0 ? 0.5 : 1; }
        else {
          out[at + K.type] = q.opened ? T_CHEST_OPEN : SPRITE_INDEX.get(q.def.sprite);
          out[at + K.price] = q.opened ? 0 : q.price || 0;                   // shop price tag
        }
      }

      // ---- familiars (renderer.js drawRoom: game.followers): none reviewed yet ----
      if (g.followers.length) for (const fo of g.followers) this._flag(`familiar:${(fo.constructor && fo.constructor.name) || 'unknown'}`);

      return this.missing;
    }

    /** The 7 x 5 window around the current room, with exactly the conditions of hud.js drawMinimap and scanMarks */
    _minimap(B, out) {
      const g = B.game, floor = g.floor, cur = g.room.cell, C = MINIMAP.length;
      const reveal = !!(B.debug && B.debug.revealMap);
      const documented = !!floor.documented;
      const ox = (MAP_W >> 1) - cur.x, oy = (MAP_H >> 1) - cur.y;
      // Deep Packet Inspection: unvisited boss and secret rooms are outlined (hud.js scanMarks)
      const marks = g.player.flags && g.player.flags.scanMap && B.HUD && B.HUD.scanMarks ? B.HUD.scanMarks(g) : null;
      for (const cell of floor.cells.values()) {
        const room = cell.room;
        const vis = room.seen || reveal;
        const gx = cell.x + ox, gy = cell.y + oy;
        const inside = gx >= 0 && gy >= 0 && gx < MAP_W && gy < MAP_H;
        // connections: drawn from a visible room that is visited (or on a documented floor) to a visible neighbour.
        // The bar sits in the gap between the two cells: mark it on whichever of them is inside the window.
        if (vis && (room.visited || reveal || documented)) {
          for (let d = 0; d < 4; d++) {
            const door = room.doors[DOOR_DIRS[d]];
            if (!door || (door.edge.hidden && !reveal) || !(door.target.room.seen || reveal)) continue;
            if (inside) out[(gy * MAP_W + gx) * C + LINK[d]] = 1;
            const nx = gx + STEP_X[d], ny = gy + STEP_Y[d];
            if (nx >= 0 && ny >= 0 && nx < MAP_W && ny < MAP_H) out[(ny * MAP_W + nx) * C + LINK_BACK[d]] = 1;
          }
        }
        let mark = null;
        if (marks) for (const m of marks) if (m.cell === cell) mark = m;
        if ((!vis && !mark) || !inside) continue;
        const at = (gy * MAP_W + gx) * C;
        out[at + M.state] = cell === cur ? 3 : room.visited ? 2 : 1;
        out[at + M.icon] = index1(MAP_ICONS, cell.type);
        if (mark) out[at + M.scan] = index1(SCAN_TYPES, mark.type);
      }
      if (marks) for (const m of marks) {
        if (!m.off) continue;   // outside the window: a dot on the edge in its direction
        const gx = Math.max(0, Math.min(MAP_W - 1, m.gx)), gy = Math.max(0, Math.min(MAP_H - 1, m.gy));
        out[(gy * MAP_W + gx) * C + M.scan_edge] = index1(SCAN_TYPES, m.type);
      }
    }
  }

  /** observer id → factory. 'none' means no observation at all (and no review gate). */
  function create(id, buffer, byteOffset) {
    if (id === undefined || id === null || id === 'none') return null;
    if (id !== ID) throw new RangeError(`unknown observation "${id}"; available: none, ${ID}`);
    return new Observer(buffer, byteOffset);
  }

  const NONE = { id: 'none', version: 0, bytes: 0, fields: [], vocab: {}, reviewed: {} };
  const describe = (id) => (id === ID ? LAYOUT : NONE);

  return { create, describe, Observer, LAYOUT, NONE, ID, VERSION, BYTES, verifyGame };
});
