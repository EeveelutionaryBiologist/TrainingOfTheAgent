/*
 * boot.js — runs after detmath.js and sim.js and BEFORE the game's scripts.
 *
 * Gives the page the same environment the headless worker gives the game (js/node/loader.js):
 *   - the deterministic math layer (unless ?math=native), so trajectories match Node bit for bit;
 *   - Math.random from a seeded stream per episode (the game uses it for visuals only);
 *   - performance.now() on the simulation clock (frame × 1000/60), so animations and the HUD's glitch flicker look
 *     exactly as they did in the recorded episode.
 * The host object is handed to Sim, which reseeds and advances it like the Node host.
 */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const detMath = params.get('math') !== 'native';
  if (detMath) window.BotaDetMath.install(Math);
  const realNow = performance.now.bind(performance);
  const host = {
    frame: 0,
    clockMs: 0,
    detMath,
    rand: window.BotaSim.mulberry32(1),
    seedVisual(seed) { host.rand = window.BotaSim.mulberry32(seed); },
    beginFrame(frame) { host.frame = frame; host.clockMs = frame * (1000 / 60); },
    realNow,
  };
  Math.random = function random() { return host.rand(); };
  performance.now = function now() { return host.clockMs; };
  window.BotaViewerHost = host;
})();
