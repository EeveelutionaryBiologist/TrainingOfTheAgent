/*
 * worker.js — one worker process of the bridge: K environments behind a blocking request/reply protocol on
 * stdin/stdout. Started and supervised by the Python side (src/bota_harness/worker.py).
 *
 * Frame, both directions (little-endian):
 *   u32 length of everything after this field | u8 op (request) or status (reply) | 3 bytes padding |
 *   u32 binLen | binLen bytes of binary | the rest: UTF-8 JSON (may be empty)
 *
 * Requests (one reply each, strictly in order):
 *   1 INIT        json { K, frameSkip, record, probe, profile, detMath, gameDir, allowUnpinned, consoleFaults,
 *                        flowLimit, testHooks, sharedCode } → json: description of the worker (see init())
 *   2 RESET       json { resets: [[i, scenario], ...] }    → bin: records, json { resets: [result, ...] }
 *   3 STEP        bin K*4 action bytes (move, shoot, push, active), json { resets } optional
 *                                                           → bin: records, json only if something happened:
 *                                                             { faults: [{ i, fault }], resets: [failed results] }
 *   4 CALL        json { i, fn, args }                     → json { result }      privileged control call
 *   5 TRANSCRIPT  json { i }                               → json { transcript }  needs record
 *   6 CLOSE                                                → no reply, the process exits
 *   7 STATS                                                → json { requests, steps, resets, busySeconds,
 *                                                                   resetSeconds, instancesBuilt, rssBytes }
 *
 * Reply status: 0 ok, 1 error (json { error, name, stack }; the request had no effect unless it says otherwise).
 *
 * STEP semantics: an environment whose index is in `resets` starts a new episode in this call and ignores its
 * action (autoreset "next step"); stepping a finished environment without a reset is an error. A reset result is
 * { i, ok: true, seed } or { i, ok: false, error, retryable, fault? }; a failed reset leaves the environment
 * without an episode and sets FLAG_RESET_FAILED in its record.
 *
 * Record per environment (recordBytes = 20 + 4 * (events + probe)), all values of the call just made:
 *   u8 flags | u8 reason (index into REASONS) | u16 0 | u32 episode | u32 frames | u32 playFrames | u32 decisions |
 *   f32 × events (js/core/events.js) | f32 × probe (js/core/probe.js, only if enabled)
 *
 * The event counters and the probe are PRIVILEGED (reward side, debugging). The observation block that follows
 * the records is empty until the fair observation exists (Phase 3): obs { id: 'none', version: 0, bytes: 0 }.
 */
'use strict';

const fs = require('node:fs');

// stdout carries the protocol; nothing else may ever write to it
for (const m of ['log', 'info', 'debug']) console[m] = (...args) => console.error(...args);

const { getGame, describe, Env, Scenario, Events, Probe, Sim } = require('./index.js');

const PROTOCOL = 1;
const OP = { INIT: 1, RESET: 2, STEP: 3, CALL: 4, TRANSCRIPT: 5, CLOSE: 6, STATS: 7 };
const FLAG = { TERMINATED: 1, TRUNCATED: 2, FAULT: 4, RESET: 8, RESET_FAILED: 16 };
const REASONS = ['none', 'death', 'cycle_end', 'room_clear', 'boss_kill', 'floor_exit', 'time_limit', 'fault'];
const OBS = { id: 'none', version: 0, bytes: 0 };
const RECORD_HEAD = 20;
const HEAD = 12;

if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('[worker] big-endian hosts are not supported');

// ---- blocking pipe I/O -------------------------------------------------------------------------------------
const napCell = new Int32Array(new SharedArrayBuffer(4));
const nap = () => Atomics.wait(napCell, 0, 0, 1);   // only reached if a pipe is in non-blocking mode

function readExact(buf, n) {
  let off = 0;
  while (off < n) {
    let got;
    try { got = fs.readSync(0, buf, off, n - off, null); } catch (err) { if (err.code === 'EAGAIN') { nap(); continue; } throw err; }
    if (got === 0) return false;   // the parent closed the pipe
    off += got;
  }
  return true;
}

function writeAll(buf, n) {
  let off = 0;
  while (off < n) {
    try { off += fs.writeSync(1, buf, off, n - off); } catch (err) { if (err.code === 'EAGAIN') { nap(); continue; } throw err; }
  }
}

// ---- state -------------------------------------------------------------------------------------------------
let K = 0, envs = [], episodes = null, cfg = null;
let nEvents = 0, nProbe = 0, recordBytes = 0, recordWords = 0;
let out = null, outBuf = null, u8 = null, u32 = null, f32 = null, binBytes = 0;
// Time accounting for benchmarks: how long the worker computed, as opposed to waiting for the next request
const stats = { requests: 0, steps: 0, resets: 0, busyNs: 0n, resetNs: 0n };

function init(c) {
  if (envs.length) throw new Error('INIT sent twice');
  if (!Number.isInteger(c.K) || c.K < 1 || c.K > 4096) throw new RangeError('K must be an integer in 1..4096');
  cfg = c;
  K = c.K;
  const loaderOpts = { gameDir: c.gameDir || undefined, profile: c.profile || undefined, detMath: c.detMath, allowUnpinned: !!c.allowUnpinned, sharedCode: !!c.sharedCode };
  const game = getGame(loaderOpts);
  const envOpts = { frameSkip: c.frameSkip, record: !!c.record, consoleFaults: c.consoleFaults, flowLimit: c.flowLimit, testHooks: !!c.testHooks };
  const meta = describe(game, envOpts);
  for (let i = 0; i < K; i++) envs.push(new Env(() => game.createInstance(), Object.assign({ meta }, envOpts)));
  episodes = new Uint32Array(K);

  nEvents = Events.NAMES.length;
  nProbe = c.probe ? Probe.NAMES.length : 0;
  recordBytes = RECORD_HEAD + 4 * (nEvents + nProbe);
  recordWords = recordBytes >> 2;
  binBytes = K * (recordBytes + OBS.bytes);
  out = new ArrayBuffer(HEAD + binBytes);
  outBuf = Buffer.from(out);
  u8 = new Uint8Array(out, HEAD);
  u32 = new Uint32Array(out, HEAD, (K * recordBytes) >> 2);
  f32 = new Float32Array(out, HEAD, (K * recordBytes) >> 2);

  return Object.assign({}, meta, {
    protocol: PROTOCOL, pid: process.pid, K,
    game: Object.assign({}, meta.game, { dir: game.source.gameDir }),
    recordBytes, obs: OBS,
    events: Events.NAMES, probe: c.probe ? Probe.NAMES : [], roomTypes: Probe.ROOM_TYPES,
    reasons: REASONS, flags: FLAG, actionNvec: Sim.ACTION_NVEC,
    record: !!c.record, consoleFaults: envs[0].consoleLevels, testHooks: !!c.testHooks, sharedCode: !!c.sharedCode,
  });
}

/** Fill environment i's record from its episode (or zeros plus `flags` if it has none) */
function writeRecord(i, flags) {
  const env = envs[i], ep = env.episode;
  const w = i * recordWords, b = i * recordBytes;
  if (!ep) {
    u32.fill(0, w, w + recordWords);
    u8[b] = flags;
    u32[w + 1] = episodes[i];
    return;
  }
  u8[b] = flags | (ep.terminated ? FLAG.TERMINATED : 0) | (ep.truncated ? FLAG.TRUNCATED : 0) | (ep.fault ? FLAG.FAULT : 0);
  u8[b + 1] = ep.reason ? REASONS.indexOf(ep.reason) : 0;
  u8[b + 2] = u8[b + 3] = 0;
  u32[w + 1] = episodes[i];
  u32[w + 2] = ep.frame - ep.startFrame;
  u32[w + 3] = ep.playFrames;
  u32[w + 4] = ep.decisions;
  f32.set(env.events.counts, w + 5);
  if (nProbe) {
    const at = w + 5 + nEvents;
    try { Probe.write(env.sim.B, f32, at); } catch (err) { f32.fill(0, at, at + nProbe); }   // state may be unusable after a fault
  }
}

function resetEnv(i, scenario) {
  const env = envs[i];
  let ep;
  const t0 = process.hrtime.bigint();
  try {
    ep = env.reset(scenario);
  } catch (err) {
    stats.resetNs += process.hrtime.bigint() - t0;
    if (!(err instanceof Scenario.ScenarioError)) throw err;
    writeRecord(i, FLAG.RESET_FAILED);
    return { i, ok: false, error: err.message, retryable: err.retryable };
  }
  stats.resets++;
  stats.resetNs += process.hrtime.bigint() - t0;
  if (ep.done) {
    // The game failed during setup, or the episode was over before the agent could act
    const res = { i, ok: false, retryable: true, fault: ep.fault || null, error: ep.fault ? ep.fault.message : `episode ended during reset (${ep.reason})` };
    env.episode = null;
    writeRecord(i, FLAG.RESET_FAILED);
    return res;
  }
  episodes[i]++;
  writeRecord(i, FLAG.RESET);
  return { i, ok: true, seed: ep.scenario.seed };
}

function resetList(json) {
  const list = json && json.resets;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) throw new TypeError('resets must be a list of [index, scenario]');
  const seen = new Set();
  for (const entry of list) {
    if (!Array.isArray(entry) || !Number.isInteger(entry[0]) || entry[0] < 0 || entry[0] >= K) throw new RangeError(`reset entry has a bad environment index: ${JSON.stringify(entry && entry[0])}`);
    if (seen.has(entry[0])) throw new RangeError(`environment ${entry[0]} is reset twice in one request`);
    seen.add(entry[0]);
  }
  return list;
}

function doReset(json) {
  const list = resetList(json);
  if (!list || !list.length) throw new Error('RESET without resets');
  return { resets: list.map(([i, scenario]) => resetEnv(i, scenario)) };
}

function doStep(bin, json) {
  if (bin.length !== K * 4) throw new RangeError(`STEP needs ${K * 4} action bytes, got ${bin.length}`);
  const list = resetList(json);
  const resetOf = list && list.length ? new Map(list) : null;
  // Check everything before any environment moves, so a refused request has no effect
  for (let i = 0; i < K; i++) {
    if (resetOf && resetOf.has(i)) continue;
    const ep = envs[i].episode;
    if (!ep || ep.done) throw new Error(`environment ${i} has no running episode; it needs a reset`);
    const a = i * 4;
    if (bin[a] > 8 || bin[a + 1] > 4 || bin[a + 2] > 1 || bin[a + 3] > 1) {
      throw new RangeError(`environment ${i}: action [${bin[a]}, ${bin[a + 1]}, ${bin[a + 2]}, ${bin[a + 3]}] is outside [9, 5, 2, 2]`);
    }
  }
  let notes = null;
  for (let i = 0; i < K; i++) {
    if (resetOf && resetOf.has(i)) {
      const res = resetEnv(i, resetOf.get(i));
      if (!res.ok) { notes = notes || {}; (notes.resets = notes.resets || []).push(res); }
      continue;
    }
    const a = i * 4;
    const ep = envs[i].step(bin[a], bin[a + 1], bin[a + 2], bin[a + 3]);
    writeRecord(i, 0);
    if (ep.fault) { notes = notes || {}; (notes.faults = notes.faults || []).push({ i, fault: ep.fault }); }
  }
  return notes;
}

function envAt(json) {
  const i = json && json.i;
  if (!Number.isInteger(i) || i < 0 || i >= K) throw new RangeError(`bad environment index ${JSON.stringify(i)}`);
  return envs[i];
}

// ---- replies -----------------------------------------------------------------------------------------------
const headBuf = Buffer.alloc(HEAD);

function reply(status, withBin, json) {
  const tail = json === null || json === undefined ? null : Buffer.from(JSON.stringify(json), 'utf8');
  const bin = withBin ? binBytes : 0;
  const head = withBin ? outBuf : headBuf;
  head.writeUInt32LE(HEAD - 4 + bin + (tail ? tail.length : 0), 0);
  head.writeUInt32LE(status, 4);   // status byte + 3 bytes padding
  head.writeUInt32LE(bin, 8);
  writeAll(head, HEAD + bin);
  if (tail) writeAll(tail, tail.length);
}

// ---- main loop ---------------------------------------------------------------------------------------------
const inHead = Buffer.alloc(HEAD);
let inBuf = Buffer.alloc(1 << 16);

for (;;) {
  if (!readExact(inHead, HEAD)) break;
  const len = inHead.readUInt32LE(0) - (HEAD - 4);
  const op = inHead[4];
  const binLen = inHead.readUInt32LE(8);
  if (len < 0 || binLen > len || len > (1 << 28)) throw new Error(`[worker] malformed frame (length ${len}, binary ${binLen})`);
  if (len > inBuf.length) inBuf = Buffer.alloc(len);
  if (!readExact(inBuf, len)) break;
  if (op === OP.CLOSE) break;
  const t0 = process.hrtime.bigint();
  stats.requests++;
  try {
    const json = len > binLen ? JSON.parse(inBuf.toString('utf8', binLen, len)) : null;
    if (op !== OP.INIT && !envs.length) throw new Error('INIT must be the first request');
    if (op === OP.INIT) reply(0, false, init(json || {}));
    else if (op === OP.STEP) { const notes = doStep(inBuf.subarray(0, binLen), json); stats.steps++; stats.busyNs += process.hrtime.bigint() - t0; reply(0, true, notes); }
    else if (op === OP.RESET) reply(0, true, doReset(json));
    else if (op === OP.CALL) reply(0, false, { result: envAt(json).call(json.fn, json.args) });
    else if (op === OP.TRANSCRIPT) reply(0, false, { transcript: envAt(json).transcript() });
    else if (op === OP.STATS) {
      reply(0, false, {
        requests: stats.requests, steps: stats.steps, resets: stats.resets, busySeconds: Number(stats.busyNs) / 1e9,
        resetSeconds: Number(stats.resetNs) / 1e9, instancesBuilt: envs.reduce((n, e) => n + e.instancesBuilt, 0),
        rssBytes: process.memoryUsage.rss(),
      });
    } else throw new Error(`unknown request ${op}`);
  } catch (err) {
    reply(1, false, { error: String(err && err.message !== undefined ? err.message : err), name: err && err.name ? err.name : 'Error', stack: err && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : null });
  }
}
