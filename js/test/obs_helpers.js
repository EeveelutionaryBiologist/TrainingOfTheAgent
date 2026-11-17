'use strict';

const { Observe } = require('../node/index.js');

const L = Observe.LAYOUT;
const FIELD = Object.fromEntries(L.fields.map((f) => [f.name, f]));
const V = L.vocab;

function rows(arr, mask, field) {
  const cols = FIELD[field].columns, n = cols.length, out = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = {};
    cols.forEach((c, k) => { o[c] = arr[i * n + k]; });
    o.typeName = V.sprites[o.type - 1] || null;
    out.push(o);
  }
  return out;
}

/** The observation of `env` (or of a bare observer's field map) as plain objects */
function decode(f) {
  const vec = (name) => Object.fromEntries(FIELD[name].columns.map((c, i) => [c, f[name][i]]));
  const doors = {};
  V.door_dirs.forEach((dir, d) => {
    const at = d * 4;
    doors[dir] = { present: f.doors[at], kind: V.door_kinds[f.doors[at + 1] - 1] || null, locked: f.doors[at + 2], closed: f.doors[at + 3] };
  });
  const mc = FIELD.minimap.columns;
  return {
    player: vec('player'), hud: vec('hud'), doors,
    enemies: rows(f.enemies, f.enemy_mask, 'enemies'),
    shots: rows(f.shots, f.shot_mask, 'shots'),
    pickups: rows(f.pickups, f.pickup_mask, 'pickups'),
    tile: (c, r) => f.tiles[r * 15 + c],
    prop: (c, r) => ({ kind: V.prop_kinds[f.tile_prop[r * 15 + c] - 1] || null, damaged: f.tile_damaged[r * 15 + c] }),
    map: (gx, gy) => Object.fromEntries(mc.map((c, i) => [c, f.minimap[(gy * 7 + gx) * mc.length + i]])),
  };
}

const bytes = (env) => Buffer.from(env.observer.raw);

module.exports = { decode, bytes, L, V, FIELD };
