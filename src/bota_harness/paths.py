"""Where the Node side of the harness lives."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from .errors import WorkerStartError

_PKG = Path(__file__).resolve().parent


def js_dir() -> Path:
    """Folder with `core/` and `node/`: $BOTA_HARNESS_JS, the copy inside an installed wheel, or the repo's js/."""
    override = os.environ.get("BOTA_HARNESS_JS")
    candidates = [Path(override)] if override else [_PKG / "_js", _PKG.parents[1] / "js"]
    for c in candidates:
        if (c / "node" / "worker.js").is_file():
            return c
    raise WorkerStartError(f"harness JavaScript not found (looked in: {', '.join(map(str, candidates))})")


def worker_script() -> Path:
    return js_dir() / "node" / "worker.js"


def node_binary(node: str | None = None) -> str:
    """Path of the Node executable: argument, $BOTA_NODE, or `node` on PATH."""
    name = node or os.environ.get("BOTA_NODE") or "node"
    found = shutil.which(name)
    if not found:
        raise WorkerStartError(f"Node executable {name!r} not found; install Node 22+ or set BOTA_NODE")
    return found
