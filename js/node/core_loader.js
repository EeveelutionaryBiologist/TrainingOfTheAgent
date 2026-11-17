/*
 * core_loader.js — a private copy of the harness core (js/core) per environment.
 *
 * Why: every game instance is compiled separately (loader.js), so its Player, Enemy, Room ... objects have
 * hidden classes of their own. Core code that is shared between environments then sees a different object shape
 * at every property access for every environment; V8 gives up specialising it and falls back to slow generic
 * lookups. The observer reads a few hundred properties per decision and was about 20 times slower that way
 * once a worker held eight environments. Compiling the core once per environment keeps each copy specialised
 * for its one game instance.
 *
 * scenario.js stays shared: it runs only at reset, and callers compare its ScenarioError class by identity.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = path.join(__dirname, '..', 'core');
const SHARED = { './scenario.js': require('../core/scenario.js') };
const sources = new Map();
let copies = 0;

function source(file) {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(CORE, file), 'utf8'));
  return sources.get(file);
}

/** Fresh copies of the per-decision core modules: { Env, Sim, Events, Probe, Control, Observe } */
function freshCore() {
  const id = copies++;
  const loaded = Object.create(null);
  const req = (name) => {
    if (SHARED[name]) return SHARED[name];
    if (loaded[name]) return loaded[name].exports;
    const file = path.basename(name);
    // The trailing comment keeps V8's compilation cache from handing out the same compiled code again
    const fn = vm.compileFunction(`${source(file)}\n// core copy ${id}`, ['module', 'exports', 'require'], { filename: path.join(CORE, file) });
    const module = loaded[name] = { exports: {} };
    fn(module, module.exports, req);
    return module.exports;
  };
  const env = req('./env.js');
  return { Env: env.Env, Sim: req('./sim.js'), Events: req('./events.js'), Probe: req('./probe.js'), Control: req('./control.js'), Observe: req('./observe.js') };
}

module.exports = { freshCore };
