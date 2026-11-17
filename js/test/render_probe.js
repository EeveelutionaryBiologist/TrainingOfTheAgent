/*
 * render_probe.js — run the game's own drawing code against a recording canvas and report what it drew.
 *
 * The observation tests use this to compare the observation with the screen mechanically: the renderer is the
 * definition of "what a human can see", so every observed thing must have been drawn, and everything drawn that
 * matters must be observed. Nothing here is used outside tests.
 */
'use strict';

/** A stand-in 2D context that records every call together with the fill and stroke style at that moment */
function recordingContext() {
  const calls = [];
  const state = { fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, font: '', textAlign: '', textBaseline: '' };
  const stack = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'save') return () => { stack.push(Object.assign({}, target)); };
      if (prop === 'restore') return () => { const s = stack.pop(); if (s) Object.assign(target, s); };
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => gradient;
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 8 });
      if (prop === 'canvas') return { width: 960, height: 640 };
      if (typeof prop !== 'string') return undefined;
      return (...args) => { calls.push({ m: prop, a: args, fill: target.fillStyle, stroke: target.strokeStyle, alpha: target.globalAlpha }); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, calls };
}

/** Run `fn(ctx)` with B.drawSprite replaced by a logger. Returns { sprites: [{ name, x, y, opts }], calls }. */
function record(B, fn) {
  const { ctx, calls } = recordingContext();
  const sprites = [];
  const original = B.drawSprite;
  B.drawSprite = (c, name, x, y, opts) => { sprites.push({ name, x, y, opts: opts || {} }); };
  try { fn(ctx); } finally { B.drawSprite = original; }
  return { sprites, calls };
}

/** What Renderer.drawRoom draws for the current room (the static background bake is skipped) */
function drawRoom(B) {
  const g = B.game, room = g.room;
  room.bgCanvas = room.bgCanvas || {};
  room.bgDirty = false;
  room.bgScale = B.renderScale || 1;
  return record(B, (ctx) => B.Renderer.drawRoom(ctx, room, g, true));
}

/** What HUD.draw draws */
function drawHud(B) {
  return record(B, (ctx) => B.HUD.draw(ctx, B.game));
}

// Geometry of the minimap panel, as in hud.js drawMinimap
const MAP = { cw: 22, ch: 15, gap: 5, w: 7, h: 5 };
MAP.pw = MAP.w * (MAP.cw + MAP.gap) + MAP.gap;
MAP.ph = MAP.h * (MAP.ch + MAP.gap) + MAP.gap;
MAP.bx = 960 - MAP.pw - 12;
MAP.by = 64 + 12;
const STATE_BY_FILL = { '#f3ece6': 3, '#7d746d': 2, 'rgba(40,34,30,0.9)': 1 };
const LINK_FILL = 'rgba(160,150,140,0.45)';

/**
 * Read the minimap back from the HUD's draw calls:
 * { cells: Map("gx,gy" → { state, icon, scan }), links: Set("gx,gy,dir") in gap form, edgeDots: [{ gx, gy, color }], static }
 */
function minimapFromHud(hud) {
  const cells = new Map(), links = new Set(), edgeDots = [];
  const cellOf = (x, y) => ({ gx: (x - MAP.bx - MAP.gap) / (MAP.cw + MAP.gap), gy: (y - MAP.by - MAP.gap) / (MAP.ch + MAP.gap) });
  const key = (gx, gy) => `${gx},${gy}`;
  let noise = false;
  for (const c of hud.calls) {
    if (c.m === 'fillRect') {
      const [x, y, w, h] = c.a;
      if (w === MAP.cw && h === MAP.ch && STATE_BY_FILL[c.fill] !== undefined) {
        const q = cellOf(x, y);
        cells.set(key(q.gx, q.gy), { state: STATE_BY_FILL[c.fill], icon: null, scan: null });
      } else if (c.fill === LINK_FILL) {
        // a bar in the gap next to a cell: work out which cell and which side
        if (w === MAP.gap && h === 4) {
          const right = cellOf(x - MAP.cw, y - MAP.ch / 2 + 2);      // drawn to the right of this cell ...
          if (Number.isInteger(right.gx) && Number.isInteger(right.gy)) links.add(`${right.gx},${right.gy},right`);
          else { const left = cellOf(x + MAP.gap, y - MAP.ch / 2 + 2); links.add(`${left.gx - 1},${left.gy},right`); }
        } else if (w === 4 && h === MAP.gap) {
          const down = cellOf(x - MAP.cw / 2 + 2, y - MAP.ch);
          if (Number.isInteger(down.gx) && Number.isInteger(down.gy)) links.add(`${down.gx},${down.gy},down`);
          else { const up = cellOf(x - MAP.cw / 2 + 2, y + MAP.gap); links.add(`${up.gx},${up.gy - 1},down`); }
        }
      } else if (w === 6 && h === 6 && (c.fill === '#ff5a5a' || c.fill === '#5fa8ff')) {
        edgeDots.push({ x: x + 3, y: y + 3, color: c.fill });
      } else if (c.fill === 'rgba(16,12,22,0.92)' && w === MAP.pw && h === MAP.ph) noise = true;
    } else if (c.m === 'strokeRect' && (c.stroke === '#ff5a5a' || c.stroke === '#5fa8ff')) {
      const [x, y, w, h] = c.a;
      if (w === MAP.cw && h === MAP.ch) { const q = cellOf(x, y); const cell = cells.get(key(q.gx, q.gy)); if (cell) cell.scan = c.stroke === '#ff5a5a' ? 'boss' : 'secret'; }
    }
  }
  for (const s of hud.sprites) {
    if (!s.name.startsWith('map_') || s.opts.scale) continue;   // the boss bar reuses map_boss, scaled
    const q = cellOf(s.x - MAP.cw / 2, s.y - MAP.ch / 2 - 1);
    const cell = cells.get(key(q.gx, q.gy));
    if (cell) cell.icon = s.name.slice(4);
  }
  return { cells, links, edgeDots, static: noise };
}

module.exports = { recordingContext, record, drawRoom, drawHud, minimapFromHud, MAP };
