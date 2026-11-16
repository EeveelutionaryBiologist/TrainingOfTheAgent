/*
 * events.js — event counters for the reward side (R12). PRIVILEGED: never part of the observation.
 *
 * The counters are fed from the game's own event bus (B.bus), so they see what the game itself reports and
 * nothing is re-derived from state. One EventCounter per game instance; the listeners stay registered for the
 * life of the instance (the bus belongs to the instance, not to a run).
 *
 * `counts` is a Float32Array in the order of NAMES. The owner decides when to clear it: Env clears at the start
 * of every decision, so after step() it holds the events of that decision.
 *
 * No Node dependencies: CommonJS module in Node, global `BotaEvents` in a browser page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotaEvents = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // name, bus event, and what one event adds. Order is part of the bridge format: append, never reorder.
  const DEFS = [
    // Damage in half hearts as the game applied it, including the part a guardrail absorbed
    ['damage_taken', 'playerHurt', (e) => e.amount],
    ['hits_taken', 'playerHurt', () => 1],
    // Hit points removed from enemies, as passed to the hit (overkill on the last hit is included)
    ['damage_dealt', 'enemyHit', (e) => e.amount],
    ['hits_dealt', 'enemyHit', () => 1],
    // Enemy entities that died; segments of multi-part enemies are not counted
    ['kills', 'enemyDeath', (e) => (e.segment ? 0 : 1)],
    // Boss entities that died (a boss made of several entities counts once per entity)
    ['boss_kills', 'enemyDeath', (e) => (e.boss ? 1 : 0)],
    ['rooms_entered', 'roomEnter', (e) => (e.first ? 1 : 0)],   // first visits only
    ['rooms_cleared', 'roomClear', () => 1],
    ['pickups', 'pickup', () => 1],
    ['items', 'itemGet', () => 1],
    ['purchases', 'purchase', () => 1],
    ['chests', 'chestOpen', () => 1],
    ['floor_exits', 'descend', () => 1],
    ['cycles', 'cycleComplete', () => 1],
    ['shots', 'shoot', () => 1],
    ['pushes', 'bombPlaced', () => 1],
    ['actives', 'activeUsed', () => 1],
    ['denied', 'denied', () => 1],        // an action the game refused (no pushes left, locked door, ...)
    ['secrets', 'secretFound', () => 1],
    ['unlocks', 'unlock', () => 1],
    ['deaths', 'playerDeath', () => 1],
  ];
  const NAMES = DEFS.map((d) => d[0]);

  class EventCounter {
    constructor(B) {
      this.counts = new Float32Array(DEFS.length);
      const counts = this.counts;
      DEFS.forEach(([, evt, add], i) => {
        B.bus.on(evt, (e) => {
          const v = add(e);
          if (typeof v === 'number' && v === v) counts[i] += v;
        });
      });
    }

    clear() { this.counts.fill(0); }

    /** { name: value } of everything that is not zero, for logs and tests */
    toObject() {
      const out = {};
      for (let i = 0; i < NAMES.length; i++) if (this.counts[i]) out[NAMES[i]] = this.counts[i];
      return out;
    }
  }

  return { EventCounter, NAMES };
});
