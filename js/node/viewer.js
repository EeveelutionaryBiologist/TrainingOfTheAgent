/*
 * viewer.js — watch recorded episodes in the real game, in a browser (R22).
 *
 *   node js/node/viewer.js [transcript.json | folder ...] [--port 8765] [--open]
 *
 * Starts a small local web server (127.0.0.1 only, no dependencies) and prints its address. The page loads the
 * pinned game from the checkout, unmodified, and replays a transcript frame by frame with the game's own renderer.
 * Transcripts come from the files and folders given here (folders are re-read on every listing, so new recordings
 * show up), or from a file picked or dropped in the page.
 *
 * Endpoints:
 *   GET /                      the viewer page; ?math=native boots without the deterministic math layer
 *   GET /api/info              { game, harness, transcripts: [{ id, name, path, seed, kind, reason, frames, decisions, ... }] }
 *   GET /api/transcripts/<id>  one transcript as JSON
 *   GET /game/<path>           the game's scripts, exactly the ones its index.html lists (main.js excepted)
 *   GET /harness/<file>        detmath.js, sim.js, scenario.js, recorder.js from js/core
 *   GET /viewer/<file>         the page's own scripts and styles (js/viewer)
 *
 * The game checkout is found and verified like everywhere else (BOTA_GAME_DIR, BOTA_ALLOW_UNPINNED).
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { verifyCheckout, resolveGameDir, scriptOrder, PINNED } = require('./loader.js');
const pkg = require('../../package.json');

const CORE_DIR = path.join(__dirname, '..', 'core');
const VIEWER_DIR = path.join(__dirname, '..', 'viewer');
const HARNESS_FILES = ['detmath.js', 'sim.js', 'scenario.js', 'recorder.js'];
const VIEWER_FILES = ['boot.js', 'viewer.js', 'viewer.css'];
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const MAX_TRANSCRIPT_BYTES = 256 * 2 ** 20;

function parseArgs(argv) {
  const o = { paths: [], port: 8765, open: false, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--open') o.open = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.paths.push(path.resolve(a));
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0..65535');
  return o;
}

/** Transcript files under the given paths: files as given, folders one level deep (*.json) */
function transcriptFiles(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (f.endsWith('.json')) out.push(path.join(p, f));
    } else out.push(p);
  }
  return [...new Set(out)];
}

/** Summary of one transcript file for the listing, or null if it is not a transcript */
function summarize(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_TRANSCRIPT_BYTES) return null;
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!t || t.format !== 1 || !t.scenario) return null;
    const r = t.result || {};
    return {
      name: path.basename(file), path: file, mtime: st.mtimeMs, bytes: st.size,
      seed: t.scenario.seed, kind: t.scenario.kind, reason: r.reason || null,
      frames: t.endFrame, playFrames: r.playFrames, decisions: r.decisions, tampered: !!t.tampered,
    };
  } catch (e) {
    return null;
  }
}

function pageHtml(gameScripts) {
  const tags = (list) => list.map((src) => `  <script src="${src}"></script>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replay Viewer</title>
  <link rel="stylesheet" href="/viewer/viewer.css">
</head>
<body>
  <header id="bar">
    <select id="pick" aria-label="Recorded episode"><option value="">Choose a recording…</option></select>
    <label class="button" id="open-file">Open file…<input type="file" id="file" accept=".json,application/json" hidden></label>
    <span id="title"></span>
    <span id="badge" class="badge" hidden></span>
  </header>
  <main id="stage">
    <canvas id="game" width="960" height="640" aria-label="Game replay"></canvas>
    <div id="drop" class="overlay">Choose a recording above, or drop a transcript file here.</div>
  </main>
  <section id="controls" aria-label="Playback controls">
    <div class="row">
      <button id="restart" title="Back to the start (Home)">⏮︎</button>
      <button id="back" title="One decision back (Shift+←)">⏪︎</button>
      <button id="play" title="Play / pause (Space)">▶︎</button>
      <button id="frame" title="One frame forward (→ while paused)">⏵︎</button>
      <button id="decision" title="One decision forward (Shift+→)">⏩︎</button>
      <select id="speed" title="Playback speed ([ and ])">
        <option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option>
        <option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="32">32×</option>
      </select>
      <span id="clock" class="mono">0:00.00</span>
      <span id="keys" aria-label="Keys held by the recording"></span>
    </div>
    <input type="range" id="seek" min="0" max="0" value="0" step="1" aria-label="Frame">
    <div class="row small">
      <span id="pos" class="mono"></span>
      <span id="state" class="mono"></span>
      <span id="note"></span>
    </div>
  </section>
  <details id="details"><summary>Recording details</summary><pre id="meta"></pre></details>
${tags(['/harness/detmath.js', '/harness/sim.js', '/viewer/boot.js'])}
${tags(gameScripts.map((f) => '/game/' + f))}
${tags(['/harness/scenario.js', '/harness/recorder.js', '/viewer/viewer.js'])}
</body>
</html>
`;
}

/**
 * The viewer's HTTP server, not yet listening.
 * opts: { paths: [transcript files or folders], gameDir, allowUnpinned }. Throws if the checkout is not usable.
 * Returns { server, info(), source, gameDir }.
 */
function createViewer(opts) {
  const o = opts || {};
  const paths = (o.paths || []).map((p) => path.resolve(p));
  const gameDir = resolveGameDir(o.gameDir);
  const source = verifyCheckout(gameDir, o.allowUnpinned !== undefined ? !!o.allowUnpinned : process.env.BOTA_ALLOW_UNPINNED === '1');
  const gameScripts = scriptOrder(gameDir).filter((f) => f !== 'src/main.js');
  const allowed = new Set(gameScripts);
  const html = pageHtml(gameScripts);
  const info = () => {
    const transcripts = [];
    for (const f of transcriptFiles(paths)) { const s = summarize(f); if (s) transcripts.push(Object.assign({ id: transcripts.length }, s)); }
    return { harness: pkg.version, game: { tag: PINNED.tag, commit: source.commit, pinned: source.pinned }, transcripts };
  };

  const server = http.createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const sendFile = (file) => fs.readFile(file, (err, data) => (err ? send(404, 'text/plain', 'not found') : send(200, TYPES[path.extname(file)] || 'application/octet-stream', data)));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed');
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { return send(400, 'text/plain', 'bad request'); }
    if (p === '/' || p === '/index.html') return send(200, TYPES['.html'], html);
    if (p === '/api/info') return send(200, TYPES['.json'], JSON.stringify(info()));
    if (p.startsWith('/api/transcripts/')) {
      const id = p.slice('/api/transcripts/'.length);
      const t = /^\d+$/.test(id) ? info().transcripts[Number(id)] : undefined;
      return t ? sendFile(t.path) : send(404, 'text/plain', 'no such transcript');
    }
    if (p.startsWith('/game/') && allowed.has(p.slice(6))) return sendFile(path.join(gameDir, p.slice(6)));
    if (p.startsWith('/harness/') && HARNESS_FILES.includes(p.slice(9))) return sendFile(path.join(CORE_DIR, p.slice(9)));
    if (p.startsWith('/viewer/') && VIEWER_FILES.includes(p.slice(8))) return sendFile(path.join(VIEWER_DIR, p.slice(8)));
    if (p === '/favicon.ico') return send(204, 'text/plain', '');
    return send(404, 'text/plain', 'not found');
  });
  return { server, info, source, gameDir };
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`viewer: ${err.message}`); process.exit(2); }
  if (opts.help) { console.log('usage: node js/node/viewer.js [transcript.json | folder ...] [--port 8765] [--open]'); return; }
  let viewer;
  try { viewer = createViewer({ paths: opts.paths }); } catch (err) { console.error(`viewer: ${err.message}`); process.exit(1); }
  const { server, info, source, gameDir } = viewer;
  let port = opts.port, tries = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && opts.port !== 0 && tries < 20) { tries++; port++; server.listen(port, opts.host); return; }
    console.error(`viewer: ${err.message}`);
    process.exit(1);
  });
  server.on('listening', () => {
    const addr = `http://${opts.host}:${server.address().port}/`;
    const n = info().transcripts.length;
    console.log(`Replay viewer: ${addr}`);
    console.log(`game ${PINNED.tag} (${source.commit.slice(0, 7)}${source.pinned ? '' : ', NOT the pinned version'}) from ${gameDir}`);
    console.log(opts.paths.length ? `${n} recording(s) from ${opts.paths.join(', ')}` : 'no recordings given; open files in the page');
    console.log('Ctrl+C to stop.');
    if (opts.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(cmd, [addr], () => {});
    }
  });
  server.listen(port, opts.host);
}

if (require.main === module) main();

module.exports = { createViewer, transcriptFiles, summarize, pageHtml, HARNESS_FILES, VIEWER_FILES };
