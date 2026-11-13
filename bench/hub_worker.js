/*
 * bench/hub_worker.js — bridge layout B for the Phase 0 benchmark: ONE Node process ("hub") that Python talks
 * to, fanning out to T worker threads over shared memory.
 *
 * Python sees the same protocol as bridge_worker.js (length-prefixed frames on stdin/stdout), but one request
 * steps all T*K envs: the hub copies the actions into a SharedArrayBuffer, wakes the threads (Atomics), each
 * thread steps its K instances and writes its observations into its slice of a shared buffer, and the hub sends
 * the whole buffer back in one reply.
 *
 *   1 INIT   JSON { T, K, obsBytes, profile }   reply: JSON { ok, commit }
 *   2 ECHO   T*K*4 action bytes                 reply: T*K*obsBytes bytes, threads not involved
 *   3 STEP   T*K*4 action bytes                 reply: T*K*obsBytes bytes after 4 frames per env
 *   4 QUIT
 *   5 LOCAL  u32 rounds                         reply: f64 seconds for that many rounds on all threads, no IPC
 *
 * Each worker thread is its own V8 isolate, so it has its own JIT state like a separate process would.
 */
'use strict';

const fs = require('node:fs');
const { Worker, isMainThread, workerData } = require('node:worker_threads');

// Control words (Int32Array on a SharedArrayBuffer)
const GEN = 0, DONE = 1, OP = 2, ARG = 3, READY = 4, CTRL_WORDS = 8;

if (!isMainThread) {
  const { loadGame } = require('../js/node/loader.js');
  const { Sim, applyAction, mulberry32 } = require('../js/core/sim.js');
  const { index, K, obsBytes, profile } = workerData;
  const ctrl = new Int32Array(workerData.ctrl);
  const actions = new Uint8Array(workerData.actions, index * K * 4, K * 4);
  const obs = new Float32Array(workerData.obs, index * K * obsBytes, (K * obsBytes) >> 2);
  const rnd = mulberry32(777 + index);
  const game = loadGame({ profile });
  const sims = [];
  for (let i = 0; i < K; i++) {
    const inst = game.createInstance();
    const sim = new Sim(inst.B, inst.host);
    sim.episodes = 0;
    sim.reset(`HUB-${index}-${i}-0`);
    sims.push(sim);
  }
  const stepAll = (useActions) => {
    for (let i = 0; i < K; i++) {
      const sim = sims[i];
      if (sim.terminal) sim.reset(`HUB-${index}-${i}-${++sim.episodes}`);
      if (sim.state === 'play') {
        if (useActions) applyAction(sim, actions[i * 4] % 9, actions[i * 4 + 1] % 5, actions[i * 4 + 2] & 1, actions[i * 4 + 3] & 1);
        else applyAction(sim, Math.floor(rnd() * 9), Math.floor(rnd() * 5), rnd() < 0.02 ? 1 : 0, rnd() < 0.02 ? 1 : 0);
      }
      for (let f = 0; f < 4; f++) sim.step();
      const p = sim.game.player, base = (i * obsBytes) >> 2;
      obs[base] = p.x; obs[base + 1] = p.y; obs[base + 2] = p.health; obs[base + 3] = sim.frame;
    }
  };
  let seen = Atomics.load(ctrl, GEN);
  Atomics.add(ctrl, READY, 1);
  Atomics.notify(ctrl, READY);
  for (;;) {
    Atomics.wait(ctrl, GEN, seen);
    const gen = Atomics.load(ctrl, GEN);
    if (gen === seen) continue;
    seen = gen;
    const op = Atomics.load(ctrl, OP);
    if (op === 4) break;
    if (op === 3) stepAll(true);
    else if (op === 5) { const rounds = Atomics.load(ctrl, ARG); for (let r = 0; r < rounds; r++) stepAll(false); }
    Atomics.add(ctrl, DONE, 1);
    Atomics.notify(ctrl, DONE);
  }
} else {
  const readExact = (buf, n) => {
    let off = 0;
    while (off < n) {
      let got;
      try { got = fs.readSync(0, buf, off, n - off, null); } catch (err) { if (err.code === 'EAGAIN') continue; throw err; }
      if (got === 0) return false;
      off += got;
    }
    return true;
  };
  const writeAll = (buf, n) => {
    let off = 0;
    while (off < n) {
      try { off += fs.writeSync(1, buf, off, n - off); } catch (err) { if (err.code === 'EAGAIN') continue; throw err; }
    }
  };
  const head = Buffer.alloc(4);
  const reply = (buf, n) => { head.writeUInt32LE(n, 0); writeAll(head, 4); writeAll(buf, n); };
  const waitFor = (ctrl, word, target) => {
    for (;;) {
      const v = Atomics.load(ctrl, word);
      if (v >= target) return;
      Atomics.wait(ctrl, word, v, 1000);
    }
  };

  let inBuf = Buffer.alloc(1 << 16);
  let T = 0, K = 0, obsBytes = 0, ctrl = null, actions = null, out = null;

  const dispatch = (op, arg) => {
    Atomics.store(ctrl, DONE, 0);
    Atomics.store(ctrl, OP, op);
    Atomics.store(ctrl, ARG, arg || 0);
    Atomics.add(ctrl, GEN, 1);
    Atomics.notify(ctrl, GEN);
    if (op !== 4) waitFor(ctrl, DONE, T);
  };

  for (;;) {
    if (!readExact(head, 4)) break;
    const len = head.readUInt32LE(0);
    if (len > inBuf.length) inBuf = Buffer.alloc(len);
    if (!readExact(inBuf, len)) break;
    const op = inBuf[0];
    if (op === 1) {
      const cfg = JSON.parse(inBuf.toString('utf8', 1, len));
      T = cfg.T; K = cfg.K; obsBytes = cfg.obsBytes;
      const ctrlSab = new SharedArrayBuffer(CTRL_WORDS * 4);
      const actSab = new SharedArrayBuffer(T * K * 4);
      const obsSab = new SharedArrayBuffer(T * K * obsBytes);
      ctrl = new Int32Array(ctrlSab);
      actions = new Uint8Array(actSab);
      out = Buffer.from(obsSab);
      for (let i = 0; i < T; i++) {
        new Worker(__filename, { workerData: { index: i, K, obsBytes, profile: cfg.profile || 'lean', ctrl: ctrlSab, actions: actSab, obs: obsSab } });
      }
      waitFor(ctrl, READY, T);
      const msg = Buffer.from(JSON.stringify({ ok: true, threads: T }));
      reply(msg, msg.length);
    } else if (op === 2) {
      reply(out, T * K * obsBytes);
    } else if (op === 3) {
      actions.set(inBuf.subarray(1, len));
      dispatch(3);
      reply(out, T * K * obsBytes);
    } else if (op === 5) {
      const t0 = process.hrtime.bigint();
      dispatch(5, inBuf.readUInt32LE(1));
      const msg = Buffer.alloc(8);
      msg.writeDoubleLE(Number(process.hrtime.bigint() - t0) / 1e9, 0);
      reply(msg, 8);
    } else {
      if (ctrl) dispatch(4);
      break;
    }
  }
  process.exit(0);
}
