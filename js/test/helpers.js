/*
 * Test helpers: scripted policies. They read the game state directly (privileged), which is fine for tests and
 * has nothing to do with what an agent may observe.
 */
'use strict';

const SHOOT = { none: 0, up: 1, down: 2, left: 3, right: 4 };

/** Move head index for a direction given as signs (-1, 0, 1) */
function moveIndex(dx, dy) {
  if (dy < 0) return dx < 0 ? 5 : dx > 0 ? 6 : 1;
  if (dy > 0) return dx < 0 ? 7 : dx > 0 ? 8 : 2;
  return dx < 0 ? 3 : dx > 0 ? 4 : 0;
}

/** Move toward a point, stopping within `tol` pixels per axis */
function walkTo(B, x, y, tol) {
  const p = B.game.player, t = tol === undefined ? 6 : tol;
  const dx = x - p.x, dy = y - p.y;
  return moveIndex(Math.abs(dx) > t ? Math.sign(dx) : 0, Math.abs(dy) > t ? Math.sign(dy) : 0);
}

/** Line up with the nearest enemy on one axis, shoot along the other, back off when it gets close */
function hunt(B) {
  const g = B.game, p = g.player;
  let best = null, bestD = Infinity;
  for (const e of g.room.enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d < bestD) { best = e; bestD = d; }
  }
  if (!best) return [0, 0];
  const dx = best.x - p.x, dy = best.y - p.y;
  const close = bestD < 150;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return [moveIndex(close ? -Math.sign(dx) : 0, Math.abs(dy) > 10 ? Math.sign(dy) : 0), dx < 0 ? SHOOT.left : SHOOT.right];
  }
  return [moveIndex(Math.abs(dx) > 10 ? Math.sign(dx) : 0, close ? -Math.sign(dy) : 0), dy < 0 ? SHOOT.up : SHOOT.down];
}

/** Walk straight into the nearest enemy */
function charge(B) {
  const g = B.game;
  const e = g.room.enemies.find((x) => !x.dead);
  return e ? [walkTo(B, e.x, e.y, 2), 0] : [0, 0];
}

/** Run a policy `(B, ep) => [move, shoot, push?, active?]` until the episode ends or maxSteps decisions pass */
function run(env, policy, maxSteps) {
  let ep = env.episode;
  for (let i = 0; i < maxSteps && !ep.done; i++) {
    const a = policy(env.B, ep);
    ep = env.step(a[0], a[1], a[2] || 0, a[3] || 0);
  }
  return ep;
}

/**
 * Policy that walks from the start room through its first open door. Returns { policy, dir }.
 * The policy lines the player up with the door first, then walks through it.
 */
function doorWalk(B) {
  const start = B.game.room;
  const dir = ['up', 'right', 'down', 'left'].find((d) => start.doors[d] && !start.doors[d].edge.locked && !start.doors[d].edge.hidden);
  const dt = B.C.DOOR_TILES[dir], door = start.tileCenter(dt.col, dt.row);
  const vertical = dir === 'up' || dir === 'down';
  const beyond = { x: door.x + B.DIRS[dir].dx * 200, y: door.y + B.DIRS[dir].dy * 200 };
  const policy = () => {
    const p = B.game.player;
    if (B.game.room !== start) return [0, 0];
    const aligned = vertical ? Math.abs(p.x - door.x) <= 6 : Math.abs(p.y - door.y) <= 6;
    return [aligned ? walkTo(B, beyond.x, beyond.y) : walkTo(B, vertical ? door.x : p.x, vertical ? p.y : door.y), 0];
  };
  return { policy, dir, start };
}

module.exports = { SHOOT, moveIndex, walkTo, hunt, charge, run, doorWalk };
