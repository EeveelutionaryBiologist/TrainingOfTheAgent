/*
 * index.js — Node entry point of the harness: load the pinned game and hand out environments.
 */
'use strict';

const { loadGame, PINNED } = require('./loader.js');
const { Env } = require('../core/env.js');
const Scenario = require('../core/scenario.js');
const Recorder = require('../core/recorder.js');
const Sim = require('../core/sim.js');
const Events = require('../core/events.js');
const Probe = require('../core/probe.js');
const Control = require('../core/control.js');
const Observe = require('../core/observe.js');
const { freshCore } = require('./core_loader.js');
const pkg = require('../../package.json');

const SHARED_CORE = { Env, Sim, Events, Probe, Control, Observe };
const games = new Map();

/** loadGame with a per-process cache, so the checkout is verified and read once per configuration */
function getGame(opts) {
  const o = opts || {};
  const key = JSON.stringify([o.gameDir || null, o.profile || null, o.detMath === undefined ? null : !!o.detMath, !!o.sharedCode, !!o.allowUnpinned]);
  if (!games.has(key)) games.set(key, loadGame(o));
  return games.get(key);
}

/** Everything that identifies how a run was produced (R16); stored in transcripts */
function describe(game, envOpts) {
  return {
    harness: pkg.version,
    game: { tag: PINNED.tag, commit: game.source.commit, pinned: game.source.pinned },
    profile: game.profile,
    detMath: game.detMath,
    frameSkip: envOpts.frameSkip === undefined ? 4 : envOpts.frameSkip,
    node: process.version,
  };
}

/**
 * Create one environment.
 * opts: loader options (gameDir, profile, detMath, allowUnpinned, sharedCode) plus Env options
 *       (frameSkip, record, consoleFaults, flowLimit, testHooks, observe, sharedCore)
 */
function createEnv(opts) {
  const o = opts || {};
  const game = getGame(o);
  // sharedCore: use the one shared copy of js/core instead of a private one (slower with several environments
  // per process, see core_loader.js; identical behaviour)
  const core = o.sharedCore ? SHARED_CORE : freshCore();
  const env = new core.Env(() => game.createInstance(), {
    frameSkip: o.frameSkip, record: o.record, consoleFaults: o.consoleFaults, flowLimit: o.flowLimit,
    testHooks: o.testHooks, observe: o.observe, meta: describe(game, o),
  });
  env.gameSource = game;
  env.core = core;   // this environment's own copies of Sim, Probe, Observe, ...
  return env;
}

module.exports = { createEnv, freshCore, getGame, describe, Env, Scenario, Recorder, Sim, Events, Probe, Control, Observe, PINNED };
