/*
 * Observation v1: the screen is the reference. These tests run the game's own drawing code against a recording
 * canvas (render_probe.js) and require the observation to say the same, and they change hidden state and require
 * the observation not to move.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv, getGame, Env, Observe, Scenario, Sim } = require('../node/index.js');
const RP = require('./render_probe.js');
const { decode, bytes, L, V } = require('./obs_helpers.js');

const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-3 : tol);
const f32 = Math.fround;
const obsOf = (env) => decode(env.observation());
/** Write the observation of the current frame directly (no step), ignoring the review gate's verdict */
const rewrite = (env) => { const missing = env.observer.write(env.B); return { o: obsOf(env), missing }; };

// ---------------------------------------------------------------------------------------------------------------
test('the layout is the frozen version 1', () => {
  const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'obs_v1.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(L)), frozen,
    'fields or vocabularies changed: that is a new observation version (bump VERSION, then node js/node/schema.js --write)');
  assert.equal(L.id, 'v1');
  assert.equal(L.version, 1);
  assert.equal(L.bytes % 4, 0);
  for (const f of L.fields) if (f.dtype === 'f4') assert.equal(f.offset % 4, 0, `${f.name} is aligned`);
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'O-LAYOUT-1', enemies: ['bug'] });
  assert.equal(env.observer.raw.length, L.bytes);
  assert.deepEqual(Object.keys(env.observation()), L.fields.map((f) => f.name));
});

// ---------------------------------------------------------------------------------------------------------------
/** Everything Renderer.drawRoom draws must be in the observation, and the other way round */
function assertRoomMatchesScreen(env, label) {
  const B = env.B, g = B.game, o = obsOf(env);
  const d = RP.drawRoom(B);
  const take = (list, pred, what) => {
    const i = list.findIndex(pred);
    assert.ok(i >= 0, `${label}: drawn but not observed: ${what}`);
    return list.splice(i, 1)[0];
  };

  // enemies: sprite, position and the visible attributes of the body
  const enemies = o.enemies.slice();
  for (const s of d.sprites.filter((x) => x.name.startsWith('enemy_'))) {
    const e = take(enemies, (q) => q.typeName === s.name && q.x === f32(s.x) && q.y === f32(s.y), `${s.name} at ${s.x},${s.y}`);
    assert.equal(e.flip, s.opts.flipX ? 1 : 0, `${label}: flip`);
    assert.equal(e.flash, s.opts.flash ? 1 : 0, `${label}: flash`);
    assert.equal(e.alpha, f32(s.opts.alpha), `${label}: alpha`);
    assert.equal(e.scale, f32(s.opts.scale), `${label}: scale`);
  }
  assert.equal(enemies.length, 0, `${label}: observed but not drawn: ${JSON.stringify(enemies[0])}`);

  // shadows show the radius and whether something flies
  const shadows = d.calls.filter((c) => c.m === 'ellipse' && c.fill === 'rgba(0,0,0,0.16)');
  for (const e of o.enemies) {
    assert.ok(shadows.some((c) => f32(c.a[0]) === e.x && near(c.a[2], e.r, 1e-3) && near(c.a[1], e.y + e.r * 0.75 + (e.flying ? 10 : 0), 1e-2)),
      `${label}: shadow of ${e.typeName} shows r ${e.r}, flying ${e.flying}`);
  }

  // things on the floor
  const pickups = o.pickups.slice();
  for (const s of d.sprites.filter((x) => x.name.startsWith('pickup_') || x.name === 'trapdoor' || x.name === 'pipe')) {
    const q = take(pickups, (k) => k.typeName === s.name && k.x === f32(s.x) && near(k.y, s.y, 2.01), `${s.name} at ${s.x},${s.y}`);
    if (s.name === 'pipe') assert.equal(q.alpha, f32(s.opts.alpha));
  }
  assert.equal(pickups.length, 0, `${label}: observed but not drawn: ${JSON.stringify(pickups[0])}`);
  const prices = d.calls.filter((c) => c.m === 'fillText' && /^\d+¢$/.test(String(c.a[0])) && c.fill !== 'rgba(0,0,0,0.6)');
  assert.deepEqual(prices.map((c) => parseInt(c.a[0], 10)).sort(), o.pickups.filter((q) => q.price).map((q) => q.price).sort(), `${label}: price tags`);

  // bombs (sprite) and plain shots (a filled circle of the shot's radius)
  const shots = o.shots.slice();
  for (const s of d.sprites.filter((x) => x.name === 'bomb')) take(shots, (q) => q.typeName === 'bomb' && q.x === f32(s.x) && q.y === f32(s.y), 'bomb');
  // plain shots are circles in the shot colours; other circles are scenery (fireflies) or highlights
  const shotColors = new Set([B.COLORS.shotPlayer, B.COLORS.shotEnemy, ...g.room.projectiles.map((q) => q.color)]);
  const circles = d.calls.filter((c) => c.m === 'arc' && shotColors.has(c.fill));
  for (const c of circles) {
    take(shots, (q) => q.typeName !== 'bomb' && q.x === f32(c.a[0]) && q.y === f32(c.a[1]) && q.r === c.a[2], `shot at ${c.a[0]},${c.a[1]}`);
  }
  assert.equal(shots.length, 0, `${label}: observed but not drawn: ${JSON.stringify(shots[0])}`);
  const teams = new Map(g.room.projectiles.filter((q) => q.constructor === B.Projectile).map((q) => [`${f32(q.x)},${f32(q.y)}`, q.color]));
  for (const q of o.shots) {
    if (q.typeName === 'bomb') continue;
    assert.equal(q.typeName, teams.get(`${q.x},${q.y}`) === B.COLORS.shotEnemy ? 'shot_enemy' : 'shot_player', `${label}: shot team by colour`);
  }

  // props: sprite prop_<kind> on a tile, frame 1 when damaged
  const drawnProps = d.sprites.filter((x) => x.name.startsWith('prop_')).map((s) => `${Math.floor(s.x / 64 + 0.05)},${Math.floor(s.y / 64)},${s.name.slice(5)},${s.opts.frame}`).sort();
  const seenProps = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 15; c++) { const p = o.prop(c, r); if (p.kind) { seenProps.push(`${c},${r},${p.kind},${p.damaged}`); assert.equal(o.tile(c, r), B.TILES.PROP); } }
  assert.deepEqual(seenProps.sort(), drawnProps, `${label}: props`);

  // player
  const ps = d.sprites.find((x) => x.name.startsWith('player'));
  if (ps) {
    assert.equal(o.player.x, f32(ps.x), `${label}: player x`);
    assert.ok(near(o.player.y, ps.y + 8, 9.01), `${label}: player y`);
    if (/^player_(up|down|left|right)$/.test(ps.name)) assert.equal(V.facings[o.player.facing], ps.name.slice(7), `${label}: facing`);
  } else assert.ok(o.player.invulnerable === 1 || g.player.dead, `${label}: the player sprite is only missing while it blinks`);

  // health bars
  const bars = d.calls.filter((c) => c.m === 'fillRect' && c.fill === '#e04848');
  assert.equal(bars.length, o.enemies.filter((e) => e.hp_shown).length, `${label}: health bars drawn`);
  for (const c of bars) {
    const e = o.enemies.find((q) => q.hp_shown && near(q.x - Math.max(24, q.r * 2) / 2, c.a[0], 1e-2));
    assert.ok(e && near(c.a[2], Math.max(24, e.r * 2) * e.hp_ratio, 1e-3), `${label}: health bar width is the observed ratio`);
  }
}

test('what the renderer draws in the room is what is observed (fight with props, shots and bombs)', () => {
  const env = createEnv();
  let checked = 0, withShots = 0, withBomb = 0, withProps = 0, fading = 0;
  // one room per prop family: crates (floor 2), bushes (3), packages and cartons (4), sandcastles (6)
  for (const [seed, depth] of [['O-ROOM-1', 2], ['O-ROOM-2', 3], ['O-ROOM-3', 4], ['O-ROOM-4', 6]]) {
    env.reset({ kind: 'test_room', seed, depth, layout: 'generated', enemies: [{ id: 'bug', count: 3 }, 'null_pointer', 'memory_leak'], endOn: [], player: { god: true, pushes: 9 } });
    assertRoomMatchesScreen(env, `${seed} reset`);
    fading += obsOf(env).enemies.filter((e) => e.alpha < 1).length;
    const rnd = Sim.mulberry32(Sim.hashString(seed));
    for (let i = 0; i < 260; i++) {
      const ep = env.step(Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.04 ? 1 : 0, 0);
      assert.equal(ep.done, false, ep.fault && ep.fault.message);
      if (i % 3) continue;
      assertRoomMatchesScreen(env, `${seed} decision ${i}`);
      const o = obsOf(env);
      checked++;
      withShots += o.shots.some((q) => q.typeName === 'shot_player') ? 1 : 0;
      withBomb += o.shots.some((q) => q.typeName === 'bomb') ? 1 : 0;
      withProps += env.game.room.props.size ? 1 : 0;
    }
  }
  assert.ok(checked > 300 && withShots > 50 && withBomb > 10 && withProps > 50 && fading > 0, `coverage: ${checked} frames, ${withShots} with shots, ${withBomb} with a bomb, ${withProps} with props, ${fading} fading in`);
});

test('what the renderer draws in the room is what is observed (things on the floor, health bars)', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'O-FLOOR-1', enemies: ['bug', 'bug', 'leaklet'], endOn: [], player: { god: true, credits: 4 } });
  const B = env.B, room = env.game.room;
  let x = 120;
  for (const type of Object.keys(B.PICKUP_TYPES)) { room.pickups.push(new B.Pickup(type, x, 150)); x += 60; }
  room.pickups.push(new B.Pickup('heart', 200, 400, { price: 3 }), new B.Pickup('guardrail', 300, 400, { price: 6 }));
  const opened = new B.Pickup('chest', 400, 400); opened.opened = true; room.pickups.push(opened);
  room.pickups.push(new B.Trapdoor(600, 400), new B.Pipe(700, 400));
  env.game.player.x = 880; env.game.player.y = 500;
  env.game.player.flags.showHp = true;
  for (const e of room.enemies) e.hurt(3, env.game);
  for (let i = 0; i < 80; i++) {
    const ep = env.step(0, 0, 0, 0);
    assert.equal(ep.done, false, ep.fault && ep.fault.message);
    assertRoomMatchesScreen(env, `decision ${i}`);
  }
  const o = obsOf(env);
  assert.equal(o.hud.pickups_total, o.pickups.length);
  assert.ok(o.pickups.length >= 14);
  for (const name of ['pickup_chest_open', 'trapdoor', 'pipe', 'pickup_readme', 'pickup_chest_locked']) assert.ok(o.pickups.some((q) => q.typeName === name), name);
  assert.deepEqual(o.pickups.filter((q) => q.price).map((q) => `${q.typeName}:${q.price}`).sort(), ['pickup_guardrail:6', 'pickup_heart:3']);
  assert.equal(o.pickups.find((q) => q.typeName === 'pipe').alpha, 1, 'the pipe is armed after 0.8 s');
  assert.ok(o.enemies.every((e) => e.hp_shown === 1 && e.hp_ratio < 1));
});

// ---------------------------------------------------------------------------------------------------------------
function assertMinimapMatchesHud(env, label) {
  const B = env.B, { o } = rewrite(env);
  const mm = RP.minimapFromHud(RP.drawHud(B));
  assert.equal(o.hud.minimap_visible, 1);
  let shown = 0;
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      const want = mm.cells.get(`${gx},${gy}`) || { state: 0, icon: null, scan: null };
      const got = o.map(gx, gy);
      const at = `${label}: map cell ${gx},${gy}`;
      assert.equal(got.state, want.state, `${at} state`);
      assert.equal(V.map_icons[got.icon - 1] || null, want.icon, `${at} icon`);
      assert.equal(V.scan_types[got.scan - 1] || null, want.scan, `${at} scan outline`);
      assert.equal(got.link_right, mm.links.has(`${gx},${gy},right`) ? 1 : 0, `${at} link right`);
      assert.equal(got.link_left, mm.links.has(`${gx - 1},${gy},right`) ? 1 : 0, `${at} link left`);
      assert.equal(got.link_down, mm.links.has(`${gx},${gy},down`) ? 1 : 0, `${at} link down`);
      assert.equal(got.link_up, mm.links.has(`${gx},${gy - 1},down`) ? 1 : 0, `${at} link up`);
      shown += want.state ? 1 : 0;
    }
  }
  // dots on the edge for scanned rooms outside the window
  const dotCells = new Set(mm.edgeDots.map((dot) => {
    const gx = dot.x < RP.MAP.bx + 10 ? 0 : dot.x > RP.MAP.bx + RP.MAP.pw - 10 ? 6 : Math.round((dot.x - RP.MAP.bx - RP.MAP.gap - RP.MAP.cw / 2) / (RP.MAP.cw + RP.MAP.gap));
    const gy = dot.y < RP.MAP.by + 10 ? 0 : dot.y > RP.MAP.by + RP.MAP.ph - 10 ? 4 : Math.round((dot.y - RP.MAP.by - RP.MAP.gap - RP.MAP.ch / 2) / (RP.MAP.ch + RP.MAP.gap));
    return `${gx},${gy}`;
  }));
  const obsDots = new Set();
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 7; gx++) if (o.map(gx, gy).scan_edge) obsDots.add(`${gx},${gy}`);
  assert.deepEqual([...obsDots].sort(), [...dotCells].sort(), `${label}: edge dots`);
  return { shown, dots: dotCells.size, scans: [...mm.cells.values()].filter((c) => c.scan).length, icons: [...mm.cells.values()].filter((c) => c.icon).length };
}

test('the minimap is what the HUD draws, room by room, with README, scanner and nothing else', () => {
  const env = createEnv();
  const seen = { rooms: 0, cells: 0, dots: 0, scans: 0, icons: 0 };
  const add = (r) => { seen.rooms++; seen.cells += r.shown; seen.dots += r.dots; seen.scans += r.scans; seen.icons += r.icons; };
  for (const [seed, depth] of [['O-MAP-1', 1], ['O-MAP-2', 1], ['O-MAP-3', 2], ['O-MAP-4', 4], ['O-MAP-5', 6]]) {
    env.reset({ kind: 'full_run', seed, depth, player: { god: true } });
    const B = env.B, g = env.game, floor = g.floor;
    const cells = [...floor.cells.values()];
    const hiddenTotal = cells.filter((c) => !c.room.seen).length;
    assert.ok(hiddenTotal > 3, 'most of the floor is unknown at the start');
    add(assertMinimapMatchesHud(env, `${seed} start`));
    const order = cells.filter((c) => c.type !== 'secret');
    order.forEach((cell, i) => {
      if (i === 2) g.player.flags.scanMap = true;                // Deep Packet Inspection from the third room on
      if (i === Math.floor(order.length / 2)) floor.documentMap();   // README.md halfway through
      g.teleport(cell.room);
      add(assertMinimapMatchesHud(env, `${seed} room ${i} (${cell.type})`));
    });
    // what was never seen is not in the observation, wherever the window is
    for (const cell of cells) {
      if (cell.room.seen) continue;
      assert.equal(cell.type, 'secret', 'after the README only secret rooms are still unknown');
      const gx = cell.x - g.room.cell.x + 3, gy = cell.y - g.room.cell.y + 2;
      if (gx >= 0 && gy >= 0 && gx < 7 && gy < 5) {
        const m = obsOf(env).map(gx, gy);
        assert.equal(m.state, 1, 'scanned: outlined like a seen room');
        assert.equal(V.scan_types[m.scan - 1], 'secret');
      }
    }
    g.player.flags.scanMap = false;
    add(assertMinimapMatchesHud(env, `${seed} scanner off`));
  }
  assert.ok(seen.rooms > 40 && seen.cells > 300 && seen.scans > 5 && seen.icons > 40 && seen.dots > 0, JSON.stringify(seen));
});

test('floor map: unseen rooms are absent until the game shows them', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'O-MAP-9', player: { god: true } });
  const g = env.game, cur = g.room.cell;
  const o = obsOf(env);
  let visible = 0;
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 7; gx++) visible += o.map(gx, gy).state ? 1 : 0;
  const neighbours = Object.values(g.room.doors).filter((d) => !d.edge.hidden).length;
  assert.equal(visible, 1 + neighbours, 'the start room and the rooms behind its visible doors');
  assert.equal(o.map(3, 2).state, 3, 'the current room is in the middle of the window');
  for (const cell of g.floor.cells.values()) {
    const gx = cell.x - cur.x + 3, gy = cell.y - cur.y + 2;
    if (gx < 0 || gy < 0 || gx >= 7 || gy >= 5) continue;
    if (!cell.room.seen) assert.deepEqual(Object.values(o.map(gx, gy)), [0, 0, 0, 0, 0, 0, 0, 0], `room type ${cell.type} at ${gx},${gy} is not on the map yet`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
test('secret rooms: nothing until the door has been blown open', () => {
  const env = createEnv();
  let found = null;
  for (let k = 0; k < 60 && !found; k++) {
    env.reset({ kind: 'full_run', seed: `O-SECRET-${k}`, player: { god: true, pushes: 3 } });
    for (const cell of env.game.floor.cells.values()) {
      if (cell.type === 'secret' || cell.type === 'boss') continue;
      for (const dir of Object.keys(cell.room.doors)) if (cell.room.doors[dir].edge.hidden && !found) found = { cell, dir };
    }
  }
  assert.ok(found, 'a floor with a hidden door');
  const B = env.B, g = env.game, room = found.cell.room, dir = found.dir, door = room.doors[dir];
  room.plannedEnemies = []; room.looseLoot = []; room.props.clear();   // a quiet room: this test is about the door
  for (let i = 0; i < room.tiles.length; i++) if (room.tiles[i] === B.TILES.PROP) room.tiles[i] = B.TILES.FLOOR;
  g.teleport(room);
  const dt = B.C.DOOR_TILES[dir], d = B.DIRS[dir];
  const tx = dt.col - d.dx, ty = dt.row - d.dy;
  g.player.x = tx * 64 + 32; g.player.y = ty * 64 + 32;   // on the floor tile in front of the hidden door
  let ep = env.step(0, 0, 0, 0);
  assert.equal(ep.done, false, ep.fault && ep.fault.message);

  const before = obsOf(env);
  assert.deepEqual(before.doors[dir], { present: 0, kind: null, locked: 0, closed: 0 }, 'no door');
  assert.equal(before.tile(dt.col, dt.row), B.TILES.WALL, 'the door tile reads as wall');
  assert.equal(room.tiles[dt.row * 15 + dt.col], B.TILES.DOOR, '(the game state knows better)');
  const sgx = 3 + d.dx, sgy = 2 + d.dy;
  assert.deepEqual(Object.values(before.map(sgx, sgy)), [0, 0, 0, 0, 0, 0, 0, 0], 'the secret room is not on the map');
  assert.equal(before.map(3, 2)['link_' + dir], 0, 'and no connection leads to it');
  assertMinimapMatchesHud(env, 'hidden');
  // the same room with an ordinary wall there instead gives the identical observation
  const hiddenBytes = bytes(env);
  const saved = room.doors[dir];
  delete room.doors[dir];
  room.tiles[dt.row * 15 + dt.col] = B.TILES.WALL;
  env.observer.write(B);
  assert.ok(bytes(env).equals(hiddenBytes), 'a hidden door and a plain wall are indistinguishable');
  room.doors[dir] = saved;
  room.tiles[dt.row * 15 + dt.col] = B.TILES.DOOR;

  // Force Push next to it, through the action space, and wait for the fuse
  ep = env.step(0, 0, 1, 0);
  for (let i = 0; i < 40 && door.edge.hidden; i++) ep = env.step(0, 0, 0, 0);
  assert.equal(door.edge.hidden, false, 'the explosion opened it');
  assert.equal(ep.done, false);
  const after = obsOf(env);
  assert.deepEqual(after.doors[dir], { present: 1, kind: 'secret', locked: 0, closed: 0 });
  assert.equal(after.tile(dt.col, dt.row), B.TILES.DOOR);
  assert.equal(after.map(sgx, sgy).state, 1, 'now seen on the map');
  assert.equal(V.map_icons[after.map(sgx, sgy).icon - 1], 'secret');
  assert.equal(after.map(3, 2)['link_' + dir], 1);
  assertMinimapMatchesHud(env, 'opened');
});

// ---------------------------------------------------------------------------------------------------------------
test('enemy health: only while the Code Review item draws health bars', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'O-HP-1', enemies: ['bug', 'bug'], endOn: [], player: { god: true } });
  env.step(0, 0, 0, 0);
  const before = bytes(env);
  const [a, b] = env.game.room.enemies;
  a.hp = 3; b.hp = 7;
  env.observer.write(env.B);
  assert.ok(bytes(env).equals(before), 'hit points changed, the observation did not');
  assert.ok(obsOf(env).enemies.every((e) => e.hp_shown === 0 && e.hp_ratio === 0));

  env.game.player.flags.showHp = true;
  env.observer.write(env.B);
  const shown = obsOf(env).enemies.map((e) => e.hp_ratio).sort();
  assert.deepEqual(shown, [f32(3 / 8), f32(7 / 8)]);
  assertRoomMatchesScreen(env, 'bars on');
  a.noHpBar = true;
  env.observer.write(env.B);
  assert.deepEqual(obsOf(env).enemies.map((e) => e.hp_shown).sort(), [0, 1], 'an enemy that suppresses its bar stays unknown');
  assertRoomMatchesScreen(env, 'one bar suppressed');
});

test('boss bar: the ratio the HUD draws, and nothing about a boss before the fight is on screen', () => {
  const env = createEnv({ observe: 'none' });   // bosses have no reviewed view yet, so the bar is checked on a bare observer
  const obs = Observe.create('v1');
  env.reset({ kind: 'test_room', seed: 'O-BOSS-1', boss: 'monolith', player: { god: true } });
  const B = env.B, boss = env.game.room.enemies.find((e) => e.isBoss);
  const missing = obs.write(B);
  assert.deepEqual(missing, ['enemy:monolith'], 'the boss itself is not reviewed');
  let o = decode(obs.f);
  assert.equal(o.enemies.length, 0, 'and is left out');
  assert.deepEqual([o.hud.boss_bar, o.hud.boss_ratio, V.bosses[o.hud.boss_type - 1], o.hud.boss_side_quest], [1, 1, 'monolith', 0]);
  boss.hp = boss.maxHp * 0.25;
  obs.write(B);
  o = decode(obs.f);
  assert.equal(o.hud.boss_ratio, 0.25);
  const bar = RP.drawHud(B).calls.filter((c) => c.m === 'fillRect' && c.a[2] > 0 && c.a[3] === 14 && typeof c.fill === 'object');
  assert.ok(bar.some((c) => near(c.a[2], 460 * 0.25)), 'the red part of the bar is a quarter of 460 px');
  boss.dead = true;
  obs.write(B);
  assert.equal(decode(obs.f).hud.boss_bar, 0, 'no bar without a living boss');
});

// ---------------------------------------------------------------------------------------------------------------
test('Graphics Glitch: the scrambled HUD area is masked for as long as the glitch lasts', () => {
  const env = createEnv();
  env.reset({ kind: 'full_run', seed: 'O-GLITCH-1', player: { god: true, health: 3, guardrails: 2, credits: 5 } });
  env.step(0, 0, 0, 0);
  const g = env.game;
  g.player.active = { id: 'ctrl_z', charge: 1 };
  const clean = rewrite(env).o;
  assert.deepEqual([clean.player.health, clean.player.max_health, clean.player.guardrails], [3, 6, 2]);
  assert.deepEqual([clean.player.hearts_visible, clean.player.stats_visible, clean.player.active_visible, clean.hud.minimap_visible], [1, 1, 1, 1]);
  assert.equal(V.active_items[clean.player.active_item - 1], 'ctrl_z');
  assert.ok(clean.player.active_max >= 1 && clean.player.active_charge === 1);
  assert.equal(clean.player.damage, f32(+g.player.stats.damage.toFixed(2)));
  assert.equal(clean.player.fire_rate, f32(+(1 / g.player.stats.fireDelay).toFixed(2)), 'the rate as printed, not the internal delay');

  const areas = {
    hearts: ['hearts_visible', 'health', 'max_health', 'guardrails'],
    stats: ['stats_visible', 'damage', 'fire_rate', 'speed', 'range', 'shot_speed', 'luck'],
    items: ['active_visible', 'active_item', 'active_charge', 'active_max'],
  };
  for (const kind of ['hearts', 'stats', 'items', 'minimap']) {
    for (const t of [2.5, 0.4]) {   // 0.4 s: the fading phase, where the game flickers; the mask stays on
      g.hudGlitch = { kind, t, dur: 3 };
      const o = rewrite(env).o;
      for (const [area, cols] of Object.entries(areas)) {
        for (const c of cols) {
          if (area === kind) assert.equal(o.player[c], 0, `${kind} glitch hides ${c}`);
          else assert.equal(o.player[c], clean.player[c], `${kind} glitch leaves ${c} alone`);
        }
      }
      assert.equal(o.hud.minimap_visible, kind === 'minimap' ? 0 : 1);
      let cells = 0;
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 7; gx++) cells += Object.values(o.map(gx, gy)).reduce((a, b) => a + b, 0);
      assert.equal(cells === 0, kind === 'minimap', 'the map is blank exactly under a minimap glitch');
      assert.deepEqual([o.player.credits, o.player.pushes, o.player.approvals], [5, clean.player.pushes, 0], 'the counters are never scrambled');
    }
    if (kind === 'minimap') assert.equal(RP.minimapFromHud(RP.drawHud(env.B)).static || g.hudGlitch.t < 1, true);
  }
  g.hudGlitch = null;
  assert.ok(Buffer.from(env.observer.raw).length && rewrite(env).o.player.health === 3);
});

// ---------------------------------------------------------------------------------------------------------------
test('hidden state does not reach the observation; visible state does', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'O-HIDDEN-1', enemies: ['bug', 'bug', 'memory_leak'], endOn: [], player: { god: true, pushes: 5 } });
  const rnd = Sim.mulberry32(77);
  for (let i = 0; i < 40; i++) env.step(Math.floor(rnd() * 9), 1 + Math.floor(rnd() * 4), i === 30 ? 1 : 0, 0);
  const B = env.B, g = env.game, room = g.room, p = g.player;
  room.pickups.push(new B.Pickup('credit', 300, 300));
  env.observer.write(B);
  const base = bytes(env);
  assert.ok(obsOf(env).shots.length >= 2 && obsOf(env).shots.some((q) => q.typeName === 'bomb'), 'a busy frame');
  const same = (label, change) => { change(); env.observer.write(B); assert.ok(bytes(env).equals(base), `${label} must not change the observation`); };
  const differs = (label, change, undo) => {
    change(); env.observer.write(B);
    assert.ok(!bytes(env).equals(base), `${label} must change the observation`);
    undo(); env.observer.write(B);
    assert.ok(bytes(env).equals(base), `${label} undone`);
  };

  // RNG, seed, bookkeeping
  same('RNG state', () => { g.rng.state = (g.rng.state ^ 0x5a5a5a5a) >>> 0; });
  same('seed', () => { g.seed = 'SOMETHING-ELSE'; });
  same('score and run statistics', () => { g.score.rooms += 3; g.runStats.kills += 7; g.runStats.rooms += 2; });
  // enemy internals
  for (const e of room.enemies) {
    same(`hit points of ${e.id}`, () => { e.hp = Math.max(1, e.hp - 2); e.maxHp += 5; });
    same(`behaviour state of ${e.id}`, () => { e.state.wanderT = 99; e.state.wanderVX = -1; e.state.bumped = true; e.state.secret = 42; });
    same(`timers and parameters of ${e.id}`, () => { e.params.count = 9; e.speed *= 2; e.contactDamage = 5; e.t += 0.01; });
    same(`internal velocity of ${e.id} (as long as the sprite is not mirrored)`, () => { e.vy += 500; e.vx = e.vx < -5 ? -400 : 400; });
  }
  // player internals
  same('fire cooldown', () => { p.fireCooldown = 0.77; });
  same('passive item list', () => { p.items.push('not_shown_anywhere'); });
  same('item state and flags that draw nothing', () => { p.itemState.x = 1; p.flags.homing = true; p.flags.multishot = 3; });
  same('internal velocity and knockback of the player', () => { p.vx += 300; p.vy -= 300; p.kbx = 50; p.kby = 50; });
  // projectiles, bombs, pickups
  for (const q of room.projectiles) {
    if (q instanceof B.Bomb) same('bomb fuse within the slow-blink phase and its damage', () => { q.fuse = Math.max(0.61, q.fuse - 0.2); q.damage = 99; q.radius = 300; });
    else same('shot damage, range, flags, velocity', () => { q.damage = 50; q.range = 9999; q.travel += 5; q.flags.homing = true; q.vx *= 2; });
  }
  same('pickup collect delay', () => { for (const q of room.pickups) q.spawnT = 5; });
  // the rest of the floor
  same('contents of other rooms', () => {
    for (const cell of g.floor.cells.values()) {
      if (cell.room === room) continue;
      cell.room.plannedEnemies = ['trojan', 'hallucination']; cell.room.looseLoot = ['chest']; cell.room.hasReadme = true; cell.room.bossId = 'x';
      cell.room.tiles.fill(B.TILES.PIT); cell.room.cleared = !cell.room.cleared;
    }
  });
  same('type of rooms that are not on the map', () => { for (const cell of g.floor.cells.values()) if (!cell.room.seen) cell.type = 'treasure'; });
  same('floor bookkeeping', () => { g.floor.keyRoom = null; g.floor.readmeRoom = null; g.pipeCooldown = 3; g.pendingBossIntro = true; });
  same('room bookkeeping', () => { room.guaranteedKey = true; room.hasPipe = true; room.spawnPoints.length = 0; room.flowTarget = 5; });

  // positive controls: what is on screen does move it
  differs('player position', () => { p.x += 1; }, () => { p.x -= 1; });
  differs('credits', () => { p.credits += 1; }, () => { p.credits -= 1; });
  differs('health', () => { p.health -= 1; }, () => { p.health += 1; });
  differs('an enemy position', () => { room.enemies[0].y += 2; }, () => { room.enemies[0].y -= 2; });
  differs('an enemy being hit', () => { room.enemies[0].flash = 0.1; }, () => { room.enemies[0].flash = 0; });
  differs('an enemy turning left', () => { room.enemies[0].__vx = room.enemies[0].vx; room.enemies[0].vx = room.enemies[0].__vx < -5 ? 10 : -10; }, () => { room.enemies[0].vx = room.enemies[0].__vx; delete room.enemies[0].__vx; });
  differs('doors closing', () => { room.combatClosed = !room.combatClosed; }, () => { room.combatClosed = !room.combatClosed; });
  differs('a rock', () => { room.tiles[3 * 15 + 3] = B.TILES.ROCK; }, () => { room.tiles[3 * 15 + 3] = B.TILES.FLOOR; });
  differs('the player blinking after a hit', () => { p.invuln = 0.5; }, () => { p.invuln = 0; });
  p.invuln = 0.5; env.observer.write(B);
  const blinking = bytes(env);
  p.invuln = 0.2; env.observer.write(B);
  assert.ok(bytes(env).equals(blinking), 'how long the blinking will last is not observed');
  p.invuln = 0; env.observer.write(B);
  const ghost = room.enemies[0];
  differs('an enemy with neither sprite nor shadow is not listed', () => { ghost.alpha = 0; ghost.noShadow = true; }, () => { ghost.alpha = 1; ghost.noShadow = false; });
  ghost.alpha = 0; ghost.noShadow = true; env.observer.write(B);
  assert.equal(obsOf(env).enemies.length, room.enemies.length - 1);
  assert.equal(obsOf(env).hud.enemies_total, room.enemies.length - 1);
  ghost.alpha = 1; ghost.noShadow = false; env.observer.write(B);
  differs('the floor number', () => { g.depth += 1; }, () => { g.depth -= 1; });
  differs('the bomb about to go off', () => { for (const q of room.projectiles) if (q instanceof B.Bomb) { q.__f = q.fuse; q.fuse = 0.3; } }, () => { for (const q of room.projectiles) if (q instanceof B.Bomb) { q.fuse = q.__f; delete q.__f; } });
});

// ---------------------------------------------------------------------------------------------------------------
test('velocities are differences of displayed positions over the last frame', () => {
  const spec = { kind: 'test_room', seed: 'O-VEL-1', enemies: ['bug', 'null_pointer'], endOn: [], player: { god: true, pushes: 3 } };
  const fine = createEnv({ frameSkip: 1 }), coarse = createEnv({ frameSkip: 4 });
  fine.reset(spec); coarse.reset(spec);
  const start = obsOf(coarse);
  assert.ok(start.player.fresh === 1 && start.enemies.every((e) => e.fresh === 1 && e.vx === 0 && e.vy === 0), 'nothing has moved on screen yet');
  const rnd = Sim.mulberry32(5);
  let moving = 0;
  for (let i = 0; i < 120; i++) {
    const a = [Math.floor(rnd() * 9), Math.floor(rnd() * 5)];
    let prev = null, last = null;
    for (let k = 0; k < 4; k++) { prev = last; fine.step(a[0], a[1], 0, 0); last = { p: { x: fine.game.player.x, y: fine.game.player.y }, e: fine.game.room.enemies.map((e) => ({ x: e.x, y: e.y })) }; }
    coarse.step(a[0], a[1], 0, 0);
    const o = obsOf(coarse);
    assert.equal(o.player.fresh, 0);
    assert.equal(o.player.vx, f32((last.p.x - prev.p.x) * 60));
    assert.equal(o.player.vy, f32((last.p.y - prev.p.y) * 60));
    // the same one-frame difference is what the frame-skip-1 environment reports
    const of = obsOf(fine);
    assert.equal(of.player.vx, o.player.vx);
    const byX = (list) => list.slice().sort((x, y) => x.x - y.x);
    byX(o.enemies).forEach((e, n) => {
      const want = byX(last.e.map((q, j) => ({ x: q.x, y: q.y, px: prev.e[j].x, py: prev.e[j].y })))[n];
      assert.equal(e.vx, f32((want.x - want.px) * 60));
      assert.equal(e.vy, f32((want.y - want.py) * 60));
      assert.equal(e.fresh, 0);
    });
    moving += Math.abs(o.player.vx) + Math.abs(o.player.vy) > 1 ? 1 : 0;
  }
  assert.ok(moving > 60);
  // the engine's own velocity is not what is reported: against a wall the player's vx stays set, the sprite stands still
  const walled = createEnv();
  walled.reset({ kind: 'test_room', seed: 'O-VEL-2', enemies: ['bug'], endOn: [], player: { god: true } });
  let o = null;
  for (let i = 0; i < 120; i++) { walled.step(3, 0, 0, 0); o = obsOf(walled); }
  assert.equal(o.player.vx, 0, 'pressed against the left wall');
  assert.ok(Math.abs(walled.game.player.vx) > 50, '(while the engine still holds a velocity)');

  // something that appears in the last frame has no velocity yet
  const one = createEnv({ frameSkip: 1 });
  one.reset(spec);
  one.step(0, 0, 1, 0);
  const bomb = obsOf(one).shots.find((q) => q.typeName === 'bomb');
  assert.deepEqual([bomb.fresh, bomb.vx, bomb.vy], [1, 0, 0]);
  one.step(0, 0, 0, 0);
  assert.equal(obsOf(one).shots.find((q) => q.typeName === 'bomb').fresh, 0);
});

test('lists are ordered by distance on screen; beyond the cap the nearest are kept and the total is reported', () => {
  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'O-CAP-1', enemies: [{ id: 'bug', count: 40 }], endOn: [], player: { god: true } });
  for (let i = 0; i < 20; i++) env.step(0, 0, 0, 0);
  const o = obsOf(env), p = env.game.player;
  assert.equal(o.hud.enemies_total, 40);
  assert.equal(o.enemies.length, 32);
  const dist = (e) => Math.hypot(e.x - p.x, e.y - p.y);
  const listed = o.enemies.map(dist);
  for (let i = 1; i < listed.length; i++) assert.ok(listed[i] >= listed[i - 1] - 1e-3, 'nearest first');
  const all = env.game.room.enemies.map(dist).sort((a, b) => a - b);
  assert.ok(near(listed[31], all[31], 1e-2), 'the 32 listed are the 32 nearest');
  assert.equal(env.episode.done, false, 'overflow is not an error');
});

// ---------------------------------------------------------------------------------------------------------------
test('review gate: scenarios with unreviewed content are refused', () => {
  const env = createEnv();
  const refused = (spec, what) => assert.throws(() => env.reset(spec), (err) => err instanceof Scenario.ScenarioError && !err.retryable && err.message.includes(`no reviewed view for: ${what}`), JSON.stringify(spec));
  refused({ kind: 'test_room', seed: 'O-GATE-1', enemies: ['hallucination'] }, 'enemy:hallucination');
  refused({ kind: 'test_room', seed: 'O-GATE-1', enemies: ['bug', 'trojan'] }, 'enemy:trojan');
  refused({ kind: 'test_room', seed: 'O-GATE-1', enemies: ['jira_ticket'] }, 'enemy:jira_ticket');
  refused({ kind: 'test_room', seed: 'O-GATE-1', boss: 'monolith' }, 'enemy:monolith');
  assert.equal(env.episode, null);
  assert.equal(env.reset({ kind: 'test_room', seed: 'O-GATE-1', enemies: ['bug', 'null_pointer', 'memory_leak', 'leaklet'] }).done, false, 'the reviewed four are fine');
  const ids = Object.keys(env.B.ENEMIES);
  assert.deepEqual(L.reviewed.enemies, ['bug', 'null_pointer', 'memory_leak', 'leaklet']);
  assert.ok(ids.length > 30, 'everything else in the game is still behind the gate');
});

test('review gate: an unreviewed thing appearing mid-episode ends the episode, not the game instance', () => {
  const env = createEnv();
  const start = () => env.reset({ kind: 'full_run', seed: 'O-GATE-2', player: { god: true } });
  const cases = [
    ['a Hallucination (disguised as a pickup)', (B, g) => g.spawnEnemy('hallucination', 300, 300), 'enemy:hallucination'],
    ['a Trojan (disguised as a prop)', (B, g) => g.spawnEnemy('trojan', 300, 300), 'enemy:trojan'],
    ['a boss', (B, g) => g.spawnBoss('monolith', 480, 200), 'enemy:monolith'],
    ['a pedestal', (B, g) => { g.teleport(g.floor.findType('treasure').room); }, 'pickup:Pedestal'],
    ['a familiar', (B, g) => g.followers.push(new (class Duck { constructor() { this.x = 0; this.y = 0; } update() {} draw() {} })()), 'familiar:Duck'],
    ['an unknown kind of projectile', (B, g) => g.room.projectiles.push(new (class Laser { constructor() { this.x = 5; this.y = 5; } update() {} draw() {} })()), 'projectile:Laser'],
    ['a shot with a sprite of its own', (B, g) => { const q = g.spawnProjectile({ x: 100, y: 100, vx: 0, vy: 0, team: 'enemy' }); q.sprite = 'enemy_bug_special'; const has = B.hasSprite; B.hasSprite = (n) => n === 'enemy_bug_special' || has(n); }, 'projectile sprite:enemy_bug_special'],
    ['a reviewed enemy that swaps its sprite', (B, g) => { const e = g.spawnEnemy('bug', 300, 300); e.spriteName = 'enemy_bug_angry'; }, 'enemy:bug'],
    ['an active item outside the vocabulary', (B, g) => { g.player.active = { id: 'mystery_box', charge: 0 }; }, 'active:mystery_box'],
  ];
  for (const [label, setup, what] of cases) {
    let ep = start();
    const built = env.instancesBuilt, inst = env.inst;
    assert.equal(env.step(0, 0, 0, 0).done, false);
    setup(env.B, env.game);
    ep = env.step(0, 0, 0, 0);
    assert.equal(ep.done, true, label);
    assert.deepEqual([ep.reason, ep.truncated, ep.terminated], ['unreviewed', true, false], label);
    assert.equal(ep.fault.kind, 'unreviewed');
    assert.ok(ep.fault.what.includes(what), `${label}: ${ep.fault.what}`);
    assert.equal(ep.fault.seed, 'O-GATE-2');
    assert.equal(env.broken, false, 'the game itself did nothing wrong');
    const o = obsOf(env);
    assert.equal(o.enemies.filter((e) => !['enemy_bug', 'enemy_null_pointer', 'enemy_memory_leak', 'enemy_leaklet'].includes(e.typeName)).length, 0, 'the unreviewed thing is not shown');
    if (label.includes('sprite of its own')) { env.inst = null; env.sim = null; }   // that case patched the instance: drop it
    else { start(); assert.equal(env.instancesBuilt, built); assert.equal(env.inst, inst); }
  }
});

test('the views are tied to the reviewed game: a behaviour that starts drawing something is noticed', () => {
  const game = getGame();
  const make = () => { const inst = game.createInstance(); inst.B.BEHAVIORS.wander.drawOver = () => {}; return inst; };
  const env = new Env(make, {});
  const ep = env.reset({ kind: 'test_room', seed: 'O-DRIFT-1', enemies: ['bug'] });
  assert.equal(ep.reason, 'fault');
  assert.match(ep.fault.message, /differs from the reviewed version.*"wander".*draws something of its own/);
  assert.ok(Buffer.from(env.observer.raw).every((b) => b === 0), 'and nothing is shown');
  assert.doesNotThrow(() => Observe.verifyGame(game.createInstance().B));
});

test('observe "none": no observation, no gate; after a game fault the observation is blank', () => {
  const none = createEnv({ observe: 'none' });
  assert.equal(none.observer, null);
  assert.equal(none.observation(), null);
  assert.equal(none.reset({ kind: 'test_room', seed: 'O-NONE-1', enemies: ['hallucination', 'trojan'], endOn: [] }).done, false);
  assert.throws(() => createEnv({ observe: 'v0' }), /unknown observation/);

  const env = createEnv();
  env.reset({ kind: 'test_room', seed: 'O-NONE-2', enemies: ['bug'] });
  env.step(0, 0, 0, 0);
  assert.ok(Buffer.from(env.observer.raw).some((b) => b !== 0));
  env.game.room.update = () => { throw new Error('boom'); };
  assert.equal(env.step(0, 0, 0, 0).reason, 'fault');
  assert.ok(Buffer.from(env.observer.raw).every((b) => b === 0));
});

test('the observation is the same for both load profiles and does not disturb the game', () => {
  const spec = { kind: 'test_room', seed: 'O-DET-1', layout: 'generated', enemies: ['bug', 'bug', 'null_pointer', 'memory_leak'], maxPlayFrames: 1200, player: { pushes: 2 } };
  const lean = createEnv({ record: true }), full = createEnv({ profile: 'full', record: true }), blind = createEnv({ observe: 'none', record: true });
  let a = lean.reset(spec), b = full.reset(spec), c = blind.reset(spec);
  const rnd = Sim.mulberry32(11);
  while (!a.done) {
    const act = [Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.02 ? 1 : 0, 0];
    a = lean.step(...act); b = full.step(...act); c = blind.step(...act);
    assert.ok(bytes(lean).equals(bytes(full)), `decision ${a.decisions}`);
  }
  assert.deepEqual([b.done, c.done, b.reason, c.reason], [true, true, a.reason, a.reason]);
  assert.equal(lean.transcript().signature, blind.transcript().signature, 'observing changes nothing in the game');
  assert.equal(lean.transcript().signature, full.transcript().signature);
});
