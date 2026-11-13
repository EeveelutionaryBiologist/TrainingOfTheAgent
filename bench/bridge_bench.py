#!/usr/bin/env python3
"""Phase 0 check: cost of the Node-to-Python bridge.

Drives bench/bridge_worker.js over stdin/stdout pipes with length-prefixed binary frames.

  1. echo      round-trip cost without any simulation, for several batch sizes and payload sizes
  2. one worker  decisions/s through the bridge versus the same loop inside Node without IPC
  3. W workers   layout A: one pipe per worker process, synchronous vector step (send to all, then read all)
  4. hub         layout B: one Node process with T worker threads over shared memory (bench/hub_worker.js),
                 one round trip per vector step

Usage: python3 bench/bridge_bench.py [--secs 3] [--profile full|lean] [--workers 16] [--only hub]
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import struct
import subprocess
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
WORKER = HERE / "bridge_worker.js"
HUB = HERE / "hub_worker.js"
F_SETPIPE_SZ = 1031
OP_INIT, OP_ECHO, OP_STEP, OP_QUIT, OP_LOCAL = 1, 2, 3, 4, 5
FRAME_SKIP = 4


class Worker:
    def __init__(self, k: int, obs_bytes: int, profile: str, threads: int = 0):
        """threads == 0: plain worker with k instances. threads > 0: hub with that many threads, k instances each."""
        self.k, self.obs_bytes = k, obs_bytes
        script = HUB if threads else WORKER
        self.proc = subprocess.Popen(["node", str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        self.wfd, self.rfd = self.proc.stdin.fileno(), self.proc.stdout.fileno()
        for fd in (self.wfd, self.rfd):
            try:
                fcntl.fcntl(fd, F_SETPIPE_SZ, 1 << 20)
            except OSError:
                pass
        self.head = bytearray(4)
        self.send(bytes([OP_INIT]) + json.dumps({"T": threads, "K": k, "obsBytes": obs_bytes, "profile": profile}).encode())
        self.info = json.loads(self.recv_bytes())

    def send(self, payload: bytes) -> None:
        data = struct.pack("<I", len(payload)) + payload
        view, off = memoryview(data), 0
        while off < len(data):
            off += os.write(self.wfd, view[off:])

    def _read_exact(self, view: memoryview) -> None:
        off = 0
        while off < len(view):
            got = os.readv(self.rfd, [view[off:]])
            if got == 0:
                raise RuntimeError("worker closed its pipe")
            off += got

    def recv_into(self, view: memoryview) -> None:
        """Read one reply straight into caller-owned memory (no intermediate copy)."""
        self._read_exact(memoryview(self.head))
        n = struct.unpack("<I", self.head)[0]
        if n != len(view):
            raise RuntimeError(f"expected {len(view)} bytes, worker sent {n}")
        self._read_exact(view)

    def recv_bytes(self) -> bytes:
        self._read_exact(memoryview(self.head))
        buf = bytearray(struct.unpack("<I", self.head)[0])
        self._read_exact(memoryview(buf))
        return bytes(buf)

    def local(self, rounds: int) -> None:
        self.send(bytes([OP_LOCAL]) + struct.pack("<I", rounds))

    def local_result(self) -> float:
        return struct.unpack("<d", self.recv_bytes())[0]

    def close(self) -> None:
        try:
            self.send(bytes([OP_QUIT]))
        except OSError:
            pass
        self.proc.wait(timeout=10)


def bench_echo(profile: str) -> list[dict]:
    rows = []
    for k in (1, 8, 64):
        for obs_bytes in (1024, 4096):
            w = Worker(k, obs_bytes, profile)
            obs = np.empty((k, obs_bytes), dtype=np.uint8)
            view = memoryview(obs).cast("B")
            req = bytes([OP_ECHO]) + bytes(k * 4)
            for _ in range(300):
                w.send(req)
                w.recv_into(view)
            n = 3000
            t0 = time.perf_counter()
            for _ in range(n):
                w.send(req)
                w.recv_into(view)
            us = (time.perf_counter() - t0) / n * 1e6
            rows.append({"K": k, "obsBytes": obs_bytes, "us_per_roundtrip": round(us, 1), "us_per_env": round(us / k, 2)})
            w.close()
    return rows


def bench_workers(n_workers: int, k: int, obs_bytes: int, secs: float, profile: str) -> dict:
    workers = [Worker(k, obs_bytes, profile) for _ in range(n_workers)]
    # Warm-up inside Node, all workers in parallel: 3000 decisions (12000 frames) per instance
    for w in workers:
        w.local(3000)
    for w in workers:
        w.local_result()
    # Baseline: the same stepping inside Node, no IPC (all workers at once, like the real load)
    rounds = max(200, int(2000 / max(1, k // 4)))
    for w in workers:
        w.local(rounds)
    local_secs = [w.local_result() for w in workers]
    local_dps = sum(rounds * k / s for s in local_secs)

    obs = np.empty((n_workers, k, obs_bytes), dtype=np.uint8)
    views = [memoryview(obs[i]).cast("B") for i in range(n_workers)]
    rng = np.random.default_rng(0)
    actions = rng.integers(0, 256, size=(64, n_workers, k * 4), dtype=np.uint8)
    reqs = [[bytes([OP_STEP]) + actions[j, i].tobytes() for i in range(n_workers)] for j in range(64)]
    n = 0
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < secs:
        for _ in range(20):
            req = reqs[n & 63]
            for i, w in enumerate(workers):
                w.send(req[i])
            for i, w in enumerate(workers):
                w.recv_into(views[i])
            n += 1
    elapsed = time.perf_counter() - t0
    for w in workers:
        w.close()
    dps = n * n_workers * k / elapsed
    return {
        "W": n_workers, "K": k, "obsBytes": obs_bytes,
        "decisions_per_s": round(dps), "frames_per_s": round(dps * FRAME_SKIP),
        "node_only_decisions_per_s": round(local_dps),
        "bridge_efficiency": round(dps / local_dps, 3),
        "ms_per_vector_step": round(elapsed / n * 1e3, 3),
    }


def bench_hub(threads: int, k: int, obs_bytes: int, secs: float, profile: str) -> dict:
    hub = Worker(k, obs_bytes, profile, threads=threads)
    envs = threads * k
    hub.local(3000)          # warm-up: 3000 decisions per instance, all threads in parallel
    hub.local_result()
    rounds = max(200, int(2000 / max(1, k // 4)))
    hub.local(rounds)
    local_dps = rounds * envs / hub.local_result()

    obs = np.empty((envs, obs_bytes), dtype=np.uint8)
    view = memoryview(obs).cast("B")
    rng = np.random.default_rng(0)
    reqs = [bytes([OP_STEP]) + rng.integers(0, 256, size=envs * 4, dtype=np.uint8).tobytes() for _ in range(64)]
    n = 0
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < secs:
        for _ in range(20):
            hub.send(reqs[n & 63])
            hub.recv_into(view)
            n += 1
    elapsed = time.perf_counter() - t0
    hub.close()
    dps = n * envs / elapsed
    return {
        "W": threads, "K": k, "obsBytes": obs_bytes,
        "decisions_per_s": round(dps), "frames_per_s": round(dps * FRAME_SKIP),
        "node_only_decisions_per_s": round(local_dps),
        "bridge_efficiency": round(dps / local_dps, 3),
        "ms_per_vector_step": round(elapsed / n * 1e3, 3),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=3.0)
    ap.add_argument("--profile", default="lean")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 16)
    ap.add_argument("--only", choices=["hub"], default=None)
    args = ap.parse_args()
    report = {"profile": args.profile, "echo": [], "single": [], "parallel": [], "hub": []}
    head = f"{'W':>4}{'K':>4}{'envs':>6}{'decisions/s':>13}{'frames/s':>11}{'Node-only dec/s':>17}{'bridge eff.':>12}{'ms/vec step':>13}"

    def row(r: dict) -> str:
        return (f"{r['W']:>4}{r['K']:>4}{r['W'] * r['K']:>6}{r['decisions_per_s']:>13}{r['frames_per_s']:>11}"
                f"{r['node_only_decisions_per_s']:>17}{r['bridge_efficiency']:>12}{r['ms_per_vector_step']:>13}")

    def run_hub() -> None:
        print(f"\n4. Hub: one process, W threads over shared memory, one round trip per vector step [{args.profile}]")
        print(head)
        for threads, k in ((args.workers, 1), (args.workers, 4), (args.workers, 8), (args.workers // 2, 8), (args.workers, 32)):
            r = bench_hub(threads, k, 4096, args.secs, args.profile)
            report["hub"].append(r)
            print(row(r))

    if args.only == "hub":
        run_hub()
        return

    print("1. Echo round trip (no simulation)")
    print(f"{'K':>4}{'obs bytes':>11}{'us/round trip':>15}{'us/env':>9}")
    for r in bench_echo(args.profile):
        report["echo"].append(r)
        print(f"{r['K']:>4}{r['obsBytes']:>11}{r['us_per_roundtrip']:>15}{r['us_per_env']:>9}")

    head = f"{'W':>4}{'K':>4}{'envs':>6}{'decisions/s':>13}{'frames/s':>11}{'Node-only dec/s':>17}{'bridge eff.':>12}{'ms/vec step':>13}"
    print(f"\n2. One worker, {FRAME_SKIP} frames per decision, 4096-byte observation per env [{args.profile}]")
    print(head)
    for k in (1, 8, 32, 64):
        r = bench_workers(1, k, 4096, args.secs, args.profile)
        report["single"].append(r)
        print(f"{r['W']:>4}{r['K']:>4}{r['W'] * r['K']:>6}{r['decisions_per_s']:>13}{r['frames_per_s']:>11}{r['node_only_decisions_per_s']:>17}{r['bridge_efficiency']:>12}{r['ms_per_vector_step']:>13}")

    print(f"\n3. {args.workers} workers, synchronous vector step [{args.profile}]")
    print(head)
    for k in (1, 8, 32):
        r = bench_workers(args.workers, k, 4096, args.secs, args.profile)
        report["parallel"].append(r)
        print(f"{r['W']:>4}{r['K']:>4}{r['W'] * r['K']:>6}{r['decisions_per_s']:>13}{r['frames_per_s']:>11}{r['node_only_decisions_per_s']:>17}{r['bridge_efficiency']:>12}{r['ms_per_vector_step']:>13}")

    run_hub()

    out = HERE / "results"
    out.mkdir(exist_ok=True)
    (out / f"bridge-{args.profile}.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
