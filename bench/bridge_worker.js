/*
 * bench/bridge_worker.js — minimal Node worker for the Phase 0 bridge benchmark (driven by bridge_bench.py).
 *
 * Protocol on stdin/stdout, blocking, one reply per request:
 *   frame   = u32 little-endian payload length, then the payload
 *   request = one opcode byte, then the body
 *     1 INIT   body = JSON { K, obsBytes, profile }            reply: JSON { ok, commit }
 *     2 ECHO   body = K*4 action bytes (ignored)               reply: K*obsBytes bytes, no simulation
 *     3 STEP   body = K*4 action bytes                         reply: K*obsBytes bytes after 4 frames per env
 *     4 QUIT
 *     5 LOCAL  body = u32 rounds                               reply: f64 seconds for that many STEP rounds
 *                                                              with random actions and no IPC (baseline, warm-up)
 * The observation here is a placeholder of realistic size; only a few values are real.
 */
'use strict';

const fs = require('node:fs');
const { loadGame } = require('../js/node/loader.js');
const { Sim, applyAction, mulberry32 } = require('../js/core/sim.js');

function readExact(buf, n) {
  let off = 0;
  while (off < n) {
    let got;
    try { got = fs.readSync(0, buf, off, n - off, null); } catch (err) { if (err.code === 'EAGAIN') continue; throw err; }
    if (got === 0) return false;   // parent closed the pipe
    off += got;
  }
  return true;
}

function writeAll(buf, n) {
  let off = 0;
  while (off < n) {
    try { off += fs.writeSync(1, buf, off, n - off); } catch (err) { if (err.code === 'EAGAIN') continue; throw err; }
  }
}

const head = Buffer.alloc(4);
let inBuf = Buffer.alloc(1 << 16);
let K = 0, obsBytes = 0, sims = [], out = null, obsF32 = null, source = null;
const rnd = mulberry32(12345);

function stepAll(actions) {
  for (let i = 0; i < K; i++) {
    const sim = sims[i];
    if (sim.terminal) sim.reset(`BRIDGE-${i}-${++sim.episodes}`);
    if (sim.state === 'play') {
      if (actions) applyAction(sim, actions[i * 4] % 9, actions[i * 4 + 1] % 5, actions[i * 4 + 2] & 1, actions[i * 4 + 3] & 1);
      else applyAction(sim, Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.02 ? 1 : 0, rnd() < 0.02 ? 1 : 0);
    }
    for (let f = 0; f < 4; f++) sim.step();
    const p = sim.game.player, base = (i * obsBytes) >> 2;
    obsF32[base] = p.x; obsF32[base + 1] = p.y; obsF32[base + 2] = p.health; obsF32[base + 3] = sim.frame;
  }
}

function reply(buf, n) {
  head.writeUInt32LE(n, 0);
  writeAll(head, 4);
  writeAll(buf, n);
}

for (;;) {
  if (!readExact(head, 4)) break;
  const len = head.readUInt32LE(0);
  if (len > inBuf.length) inBuf = Buffer.alloc(len);
  if (!readExact(inBuf, len)) break;
  const op = inBuf[0];
  if (op === 1) {
    const cfg = JSON.parse(inBuf.toString('utf8', 1, len));
    K = cfg.K; obsBytes = cfg.obsBytes;
    const game = loadGame({ profile: cfg.profile || 'lean' });
    source = game.source;
    sims = [];
    for (let i = 0; i < K; i++) {
      const inst = game.createInstance();
      const sim = new Sim(inst.B, inst.host);
      sim.episodes = 0;
      sim.reset(`BRIDGE-${i}-0`);
      sims.push(sim);
    }
    out = Buffer.alloc(K * obsBytes);
    obsF32 = new Float32Array(out.buffer, out.byteOffset, (K * obsBytes) >> 2);
    const msg = Buffer.from(JSON.stringify({ ok: true, commit: source.commit }));
    reply(msg, msg.length);
  } else if (op === 2) {
    reply(out, K * obsBytes);
  } else if (op === 3) {
    stepAll(inBuf.subarray(1, len));
    reply(out, K * obsBytes);
  } else if (op === 5) {
    const rounds = inBuf.readUInt32LE(1);
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < rounds; r++) stepAll(null);
    const msg = Buffer.alloc(8);
    msg.writeDoubleLE(Number(process.hrtime.bigint() - t0) / 1e9, 0);
    reply(msg, 8);
  } else {
    break;
  }
}
