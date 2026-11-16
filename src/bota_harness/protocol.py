"""Wire format between Python and a Node worker (js/node/worker.js holds the authoritative description).

Frame, both directions, little-endian:
    u32 length of everything after this field | u8 op or status | 3 bytes padding | u32 binLen | binary | JSON
"""
from __future__ import annotations

import struct

import numpy as np

PROTOCOL = 1

OP_INIT, OP_RESET, OP_STEP, OP_CALL, OP_TRANSCRIPT, OP_CLOSE, OP_STATS = 1, 2, 3, 4, 5, 6, 7

FLAG_TERMINATED, FLAG_TRUNCATED, FLAG_FAULT, FLAG_RESET, FLAG_RESET_FAILED = 1, 2, 4, 8, 16

#: Why an episode ended; `info["reason"]` holds indices into this tuple.
REASONS = ("none", "death", "cycle_end", "room_clear", "boss_kill", "floor_exit", "time_limit", "fault")
REASON_FAULT = REASONS.index("fault")

#: The action heads: move (none + 8 directions), shoot (none + 4), Force Push, active item.
ACTION_NVEC = (9, 5, 2, 2)
MOVES = ("none", "up", "down", "left", "right", "up-left", "up-right", "down-left", "down-right")
SHOTS = ("none", "up", "down", "left", "right")

HEAD = struct.Struct("<IB3xI")
HEAD_BYTES = HEAD.size            # 12
RECORD_HEAD_BYTES = 20


def pack(op: int, binary: bytes = b"", tail: bytes = b"") -> bytes:
    """One request frame."""
    return HEAD.pack(HEAD_BYTES - 4 + len(binary) + len(tail), op, len(binary)) + binary + tail


def record_dtype(n_events: int, n_probe: int) -> np.dtype:
    """Per-environment record of a STEP or RESET reply, as a structured dtype."""
    names = ["flags", "reason", "worker_episode", "frames", "play_frames", "decisions", "events"]
    formats: list = ["u1", "u1", "<u4", "<u4", "<u4", "<u4", ("<f4", (n_events,))]
    offsets = [0, 1, 4, 8, 12, 16, RECORD_HEAD_BYTES]
    if n_probe:
        names.append("probe")
        formats.append(("<f4", (n_probe,)))
        offsets.append(RECORD_HEAD_BYTES + 4 * n_events)
    return np.dtype({"names": names, "formats": formats, "offsets": offsets,
                     "itemsize": RECORD_HEAD_BYTES + 4 * (n_events + n_probe)})
