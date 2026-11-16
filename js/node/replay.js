/*
 * replay.js — replay recorded episodes in Node and check that they end in the recorded state.
 *
 *   node js/node/replay.js <transcript.json> [more.json ...]      (or one transcript on stdin with "-")
 *
 * Prints one JSON line per transcript: { file, ok, signature, expected, frames, tampered }.
 * Exit code 0 if every replay matched, 1 otherwise. The game checkout is found and verified like everywhere else
 * (BOTA_GAME_DIR, BOTA_ALLOW_UNPINNED); profile and math layer are taken from the transcript.
 */
'use strict';

const fs = require('node:fs');
const { getGame, Recorder } = require('./index.js');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node js/node/replay.js <transcript.json> [...]   ("-" reads stdin)');
  process.exit(2);
}

let allOk = true;
for (const file of files) {
  const out = { file, ok: false };
  try {
    const t = JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8'));
    const meta = t.meta || {};
    // The math layer is fixed per process; a transcript recorded with the other setting needs its own run
    const game = getGame({ profile: meta.profile, detMath: meta.detMath });
    const res = Recorder.replay(game.createInstance(), t);
    Object.assign(out, { ok: res.ok, signature: res.signature, expected: res.expected, frames: res.frames, tampered: !!t.tampered });
    if (meta.game && meta.game.commit !== game.source.commit) out.note = `recorded on game ${meta.game.commit}, replayed on ${game.source.commit}`;
  } catch (err) {
    out.error = String(err && err.message !== undefined ? err.message : err);
  }
  if (!out.ok) allOk = false;
  process.stdout.write(JSON.stringify(out) + '\n');
}
process.exit(allOk ? 0 : 1);
