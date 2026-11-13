/*
 * loader.js — loads the pinned game from a local checkout into plain Node, without a browser.
 *
 * - Verifies the checkout (pinned commit, clean tree for index.html and src/).
 * - Reads the script order from the game's index.html and compiles all files, unmodified, into ONE factory
 *   function whose parameters shadow the browser globals the game touches. Every call of the factory gives an
 *   independent game instance in the same realm (full JIT speed, many instances per process).
 * - main.js is never loaded: it only wires canvas, real keyboard and the requestAnimationFrame loop. Its
 *   bootstrap (storage, mute, new Game) is done here instead.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { mulberry32 } = require('../core/sim.js');

const PINNED = Object.freeze({ tag: 'v1.0', commit: 'cc5cba4722bed36df823645b0aab24a8a31d1863' });
const SKIP_ALWAYS = ['src/main.js'];
const SKIP_LEAN = ['src/core/audio.js', 'src/entities/effects.js'];
const HOST_PARAMS = ['window', 'document', 'performance', 'requestAnimationFrame', 'console', 'localStorage', 'location'];
const noop = () => {};

function resolveGameDir(dir) {
  return path.resolve(dir || process.env.BOTA_GAME_DIR || path.join(__dirname, '..', '..', '..', 'BindingOfTheAgent'));
}

/** Check that the checkout is the pinned version. Throws unless allowUnpinned is set. */
function verifyCheckout(gameDir, allowUnpinned) {
  const git = (...args) => execFileSync('git', ['-C', gameDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let commit, dirty;
  try {
    commit = git('rev-parse', 'HEAD');
    dirty = git('status', '--porcelain', '--', 'index.html', 'src');
  } catch (err) {
    throw new Error(`[loader] ${gameDir} is not a usable git checkout of the game: ${err.message}`);
  }
  const info = { gameDir, commit, clean: dirty === '', pinned: commit === PINNED.commit && dirty === '', expected: PINNED };
  if (!info.pinned && !allowUnpinned) {
    throw new Error(`[loader] game checkout is not the pinned version ${PINNED.tag} (${PINNED.commit.slice(0, 7)}): ` +
      `HEAD ${commit.slice(0, 7)}, ${info.clean ? 'clean' : 'modified files in index.html/src'}. ` +
      'Set allowUnpinned (or BOTA_ALLOW_UNPINNED=1) to run anyway; results are then not comparable.');
  }
  return info;
}

/** Script paths in load order, as listed in the game's index.html */
function scriptOrder(gameDir) {
  const html = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  if (!files.length) throw new Error('[loader] no <script src> entries found in index.html');
  return files;
}

// Math.random is used by the game for visuals only. All instances share the realm, so the global is replaced
// once by a dispatcher that reads from the currently active instance's seeded stream.
let activeRand = null;
function installRandomDispatcher() {
  if (Math.random.botaDispatcher) return;
  const native = Math.random;
  const dispatcher = function random() { return activeRand ? activeRand() : native(); };
  dispatcher.botaDispatcher = true;
  Math.random = dispatcher;
}

/** Browser stand-ins for one instance, plus the capture of everything the game logs */
function makeHost() {
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d, focus: noop, addEventListener: noop });
  const host = {
    frame: 0,
    clockMs: 0,
    rand: mulberry32(1),
    errors: [],   // { level, frame, text } — console.warn / console.error from the game
    seedVisual(seed) { host.rand = mulberry32(seed); },
    /** Call before stepping this instance: selects its random stream and advances its clock */
    beginFrame(frame) { host.frame = frame; host.clockMs = frame * (1000 / 60); activeRand = host.rand; },
  };
  const log = (level) => (...args) => host.errors.push({ level, frame: host.frame, text: args.map((a) => (a && a.stack) || String(a)).join(' ') });
  host.console = { log: noop, info: noop, debug: noop, warn: log('warn'), error: log('error') };
  const window = {
    performance: { now: () => host.clockMs },
    requestAnimationFrame: noop,
    addEventListener: noop,
    removeEventListener: noop,
    innerWidth: 960, innerHeight: 640, devicePixelRatio: 1,
    location: { search: '' },
    localStorage: { getItem: () => null, setItem: noop },
    document: { getElementById: canvas, createElement: canvas, addEventListener: noop },
    console: host.console,
  };
  window.window = window;
  host.window = window;
  return host;
}

// Engine-independent Math (js/core/detmath.js). It replaces functions on the realm's Math object, so it is a
// per-process choice: every loadGame call in one process must agree.
let detMathState = null;
function configureDetMath(wanted) {
  if (detMathState !== null && detMathState !== wanted) {
    throw new Error('[loader] detMath must be the same for every loadGame call in one process');
  }
  if (detMathState === null && wanted) require('../core/detmath.js').install(Math);
  detMathState = wanted;
}

/**
 * Load the game.
 * opts: { gameDir, profile: 'full' | 'lean', allowUnpinned, detMath, sharedCode }
 *   profile: default 'lean' (no audio.js / effects.js; same trajectories as 'full', see docs/phase0-results.md)
 *   detMath: use the engine-independent Math functions (default true; BOTA_DETMATH=0 turns it off)
 * Returns { source, profile, detMath, files, createInstance() -> { B, host } }
 */
function loadGame(opts) {
  const o = opts || {};
  const profile = o.profile || 'lean';
  if (profile !== 'full' && profile !== 'lean') throw new Error(`[loader] unknown profile ${profile}`);
  const detMath = o.detMath !== undefined ? !!o.detMath : process.env.BOTA_DETMATH !== '0';
  configureDetMath(detMath);
  const gameDir = resolveGameDir(o.gameDir);
  const source = verifyCheckout(gameDir, o.allowUnpinned || process.env.BOTA_ALLOW_UNPINNED === '1');
  const skip = new Set(profile === 'lean' ? SKIP_ALWAYS.concat(SKIP_LEAN) : SKIP_ALWAYS);
  const files = scriptOrder(gameDir).filter((f) => !skip.has(f));
  // Each file keeps its own function scope and its own 'use strict' directive, as a classic script would.
  const body = files.map((f) => `// ---- ${f}\n;(function () {\n${fs.readFileSync(path.join(gameDir, f), 'utf8')}\n})();`).join('\n');
  // sharedCode: every instance is created from the same compiled function. That shares V8's type feedback and
  // optimised code between instances, which have distinct classes each, so call sites turn megamorphic and
  // stepping gets several times slower once a process holds more than a few instances.
  // Default: compile once per instance (a unique trailing comment keeps V8's compilation cache from merging them).
  const sharedCode = !!o.sharedCode;
  let compiled = 0;
  const compile = () => vm.compileFunction(`${body}\nreturn window.BOTA;\n// instance ${compiled++}`, HOST_PARAMS, { filename: `bota-${PINNED.tag}-${profile}.js` });
  const sharedFactory = sharedCode ? compile() : null;
  installRandomDispatcher();

  function createInstance() {
    const factory = sharedFactory || compile();
    const host = makeHost();
    const w = host.window;
    host.beginFrame(0);
    const B = factory(w, w.document, w.performance, w.requestAnimationFrame, host.console, w.localStorage, w.location);
    if (!B.audio) B.audio = { muted: true, unlock: noop, play: noop, toggleMute: noop, music: { start: noop, stop: noop } };
    // What main.js would do, minus canvas, real keyboard and the frame loop
    B.storage.load();
    B.audio.muted = true;
    B.game = new B.Game();
    return { B, host };
  }

  return { source, profile, detMath, files, createInstance };
}

module.exports = { loadGame, verifyCheckout, resolveGameDir, scriptOrder, PINNED };
