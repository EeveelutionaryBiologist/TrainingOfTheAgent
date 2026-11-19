"""Recorded episodes: save and load transcripts, check them by replaying in Node (js/node/replay.js), and watch
them in the real game in a browser (js/node/viewer.js, `bota-harness view`).

A transcript replays as a plain frame loop that feeds the recorded key events to a fresh game; `ok` means the
replay ended in the recorded state (R22).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping

from .errors import HarnessError
from .paths import js_dir, node_binary


TRANSCRIPT_FORMAT = 1


def _auto_name(transcript: Mapping[str, Any]) -> str:
    sc = transcript.get("scenario") or {}
    reason = (transcript.get("result") or {}).get("reason") or "running"
    parts = [str(sc.get("kind", "episode")), str(sc.get("seed", "")), str(reason), time.strftime("%Y%m%d-%H%M%S")]
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", "-".join(p for p in parts if p))


def save_transcript(transcript: Mapping[str, Any], path: str | os.PathLike) -> Path:
    """Write a transcript as JSON and return the file's path.

    `path` is a file name, or a folder (existing, or given with a trailing slash): the file is then named after
    the scenario, seed, end reason and time, e.g. `test_room-K3J9Q2-room_clear-20261119-142233.json`, with a
    number appended if that name is taken. Missing folders are created. The write is atomic.
    """
    if not isinstance(transcript, Mapping) or transcript.get("format") != TRANSCRIPT_FORMAT:
        raise HarnessError("not a transcript (expected a dict with format 1, as env.transcript(i) returns)")
    target = Path(path)
    if target.is_dir() or str(path).endswith(("/", os.sep)):
        base = _auto_name(transcript)
        target = target / f"{base}.json"
        n = 1
        while target.exists():
            n += 1
            target = target.parent / f"{base}-{n}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(transcript, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, target)
    return target


def load_transcript(path: str | os.PathLike) -> dict[str, Any]:
    """Read a transcript written by `save_transcript` (or any JSON file holding one)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("format") != TRANSCRIPT_FORMAT:
        raise HarnessError(f"{path} does not hold a transcript (format {TRANSCRIPT_FORMAT})")
    return data


def verify(transcript: Mapping[str, Any] | str | os.PathLike, *, game_dir: str | os.PathLike | None = None,
           node: str | None = None, timeout: float = 300.0) -> dict[str, Any]:
    """Replay one transcript (a dict, or the path of a JSON file).

    Returns {"ok", "signature", "expected", "frames", "tampered"}; on a transcript that cannot be replayed at
    all, {"ok": False, "error": ...}.
    """
    env = dict(os.environ)
    if game_dir is not None:
        env["BOTA_GAME_DIR"] = os.fspath(game_dir)
    script = str(js_dir() / "node" / "replay.js")
    if isinstance(transcript, Mapping):
        path, data = "-", json.dumps(transcript)      # handed over on stdin
    else:
        path, data = os.fspath(transcript), None
    proc = subprocess.run([node_binary(node), script, path], input=data, capture_output=True, text=True,
                          timeout=timeout, env=env)
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not lines:
        raise HarnessError(f"replay produced no result (exit code {proc.returncode}): {proc.stderr.strip()[-500:]}")
    return json.loads(lines[-1])
