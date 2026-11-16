"""Check recorded episodes by replaying them in Node (js/node/replay.js).

A transcript replays as a plain frame loop that feeds the recorded key events to a fresh game; `ok` means the
replay ended in the recorded state. The same transcript replays in the real game in a browser (R22).
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Mapping

from .errors import HarnessError
from .paths import js_dir, node_binary


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
