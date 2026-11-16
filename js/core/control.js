/*
 * control.js — control calls on a running environment. PRIVILEGED.
 *
 * These wrap the game's own debug hooks (BOTA.debug.*) and the probe. They are reachable only through an explicit
 * control call of the harness (Env → worker → Python `call()`), never through the action space (R11). Using one
 * changes the episode in a way a recording of key events cannot reproduce, so the environment marks the episode
 * as `tampered` and its transcript says so.
 *
 * No Node dependencies: CommonJS module in Node, global `BotaControl` in a browser page (after BotaSim, BotaProbe).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'), require('./probe.js'));
  else root.BotaControl = factory(root.BotaSim, root.BotaProbe);
})(typeof self !== 'undefined' ? self : this, function (S, Probe) {
  'use strict';

  const str = (v, what) => { if (typeof v !== 'string' || !v) throw new TypeError(`${what} must be a non-empty string`); return v; };
  const optNum = (v, what) => { if (v !== undefined && v !== null && !Number.isFinite(v)) throw new TypeError(`${what} must be a number`); return v === null ? undefined : v; };

  // name → { mutates, run(B, args) }. Reading calls leave the episode untouched.
  const CALLS = {
    snapshot: { mutates: false, run: (B) => Probe.snapshot(B) },
    signature: { mutates: false, run: (B) => { const h = new S.Hasher(); S.hashState(B, h); return h.hex(); } },
    god: { mutates: true, run: (B, a) => B.debug.god(a[0] === undefined ? true : !!a[0]) },
    giveItem: { mutates: true, run: (B, a) => { const id = str(a[0], 'item id'); if (!B.ITEMS[id]) throw new RangeError(`unknown item id "${id}"`); return B.debug.giveItem(id); } },
    resources: { mutates: true, run: (B, a) => { B.debug.resources(optNum(a[0], 'amount')); return null; } },
    spawn: { mutates: true, run: (B, a) => { const id = str(a[0], 'enemy id'); if (!B.ENEMIES[id]) throw new RangeError(`unknown enemy id "${id}"`); B.debug.spawn(id, optNum(a[1], 'x'), optNum(a[2], 'y')); return null; } },
    spawnBoss: { mutates: true, run: (B, a) => { const id = str(a[0], 'boss id'); if (!B.BOSSES[id]) throw new RangeError(`unknown boss id "${id}"`); B.debug.spawnBoss(id, optNum(a[1], 'x'), optNum(a[2], 'y')); return null; } },
    gotoRoom: { mutates: true, run: (B, a) => { B.debug.gotoRoom(str(a[0], 'room type')); return null; } },
    nextFloor: { mutates: true, run: (B) => { B.debug.nextFloor(); return null; } },
    killAll: { mutates: true, run: (B) => { B.debug.killAll(); return null; } },
  };

  // Fault injection for the harness's own tests. Only reachable when the caller enables test hooks.
  const TEST_CALLS = {
    __throw: { mutates: true, run: (B) => { B.game.room.update = () => { throw new Error('injected exception'); }; return null; } },
    __hang: { mutates: true, run: (B) => { B.game.room.update = () => { for (;;) { /* never returns */ } }; return null; } },
    // An error the game swallows and logs: a bus listener that throws on the next room update
    __consoleError: {
      mutates: true,
      run: (B) => {
        const room = B.game.room, update = room.update;
        room.update = function (...args) {
          room.update = update;
          const off = B.bus.on('__botaTest', () => { throw new Error('injected listener error'); });
          B.bus.emit('__botaTest', {});
          off();
          return update.apply(this, args);
        };
        return null;
      },
    },
  };

  /** Run a control call. Returns { result, mutates }. Throws for unknown names and bad arguments. */
  function call(B, name, args, allowTestHooks) {
    const entry = Object.prototype.hasOwnProperty.call(CALLS, name) ? CALLS[name]
      : allowTestHooks && Object.prototype.hasOwnProperty.call(TEST_CALLS, name) ? TEST_CALLS[name] : null;
    if (!entry) throw new RangeError(`unknown control call "${name}"; available: ${Object.keys(CALLS).join(', ')}`);
    const result = entry.run(B, Array.isArray(args) ? args : []);
    return { result: result === undefined ? null : result, mutates: entry.mutates };
  }

  return { call, NAMES: Object.keys(CALLS) };
});
