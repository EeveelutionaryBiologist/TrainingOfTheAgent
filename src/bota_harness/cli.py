"""Command line: `bota-harness info | bench | replay`."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

from . import protocol as P
from .replay import verify
from .scenario import FullRun
from .task import ReferenceTask, ScenarioTask
from .vec_env import BotaVecEnv


def _env_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--game-dir", default=None, help="game checkout (default: $BOTA_GAME_DIR, then ../BindingOfTheAgent)")
    ap.add_argument("--profile", default="lean", choices=["lean", "full"])
    ap.add_argument("--allow-unpinned", action="store_true", help="run a checkout that is not the pinned version")


def cmd_info(args: argparse.Namespace) -> int:
    env = BotaVecEnv(1, game_dir=args.game_dir, profile=args.profile, allow_unpinned=args.allow_unpinned)
    try:
        print(json.dumps(env.describe(), indent=2))
    finally:
        env.close()
    return 0


def cmd_bench(args: argparse.Namespace) -> int:
    """Random policy across all workers; reports decisions per second and where the time goes."""
    workers = args.workers or min(args.envs, os.cpu_count() or 1)
    if args.scenario == "full_run":
        task = ScenarioTask(FullRun(max_play_frames=args.max_play_frames))
    else:
        task = ReferenceTask(max_play_frames=args.max_play_frames)
    env = BotaVecEnv(args.envs, task, workers=workers, game_dir=args.game_dir, profile=args.profile,
                     allow_unpinned=args.allow_unpinned, frame_skip=args.frame_skip, spin_wait=args.spin_wait,
                     shared_code=args.shared_code, probe=args.probe, obs=args.obs)
    try:
        n = env.num_envs
        rng = np.random.default_rng(args.seed)
        actions = rng.integers(0, P.ACTION_NVEC, size=(256, n, 4))
        env.reset(seed=args.seed)
        t_end = time.perf_counter() + args.warmup
        t = 0
        while time.perf_counter() < t_end:
            env.step(actions[t & 255])
            t += 1
        before = env.worker_stats()
        episodes: dict[str, int] = {}
        successes = judged = steps = 0
        faults0, restarts0 = env.fault_count, env.worker_restarts
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < args.secs:
            for _ in range(20):
                _, _, _, _, info = env.step(actions[(t + steps) & 255])
                steps += 1
                if "result" in info:
                    for res in info["result"][info["_result"]]:
                        episodes[res.reason] = episodes.get(res.reason, 0) + 1
                        if res.success is not None:
                            judged += 1
                            successes += res.success
        elapsed = time.perf_counter() - t0
        after = env.worker_stats()
        busy = [b["busySeconds"] - a["busySeconds"] for a, b in zip(before, after)]
        resets = sum(b["resets"] - a["resets"] for a, b in zip(before, after))
        reset_s = sum(b["resetSeconds"] - a["resetSeconds"] for a, b in zip(before, after))
        n_eps = sum(episodes.values())
        report = {
            "envs": n, "workers": workers, "frame_skip": env.frame_skip, "scenario": args.scenario,
            "obs": f"{env.obs_layout['id']} ({env.obs_layout['bytes']} bytes per env)",
            "decisions_per_s": round(steps * n / elapsed), "frames_per_s": round(steps * n * env.frame_skip / elapsed),
            "ms_per_vector_step": round(elapsed / steps * 1e3, 3),
            "worker_busy_share": round(float(np.mean(busy)) / elapsed, 3),
            "us_per_decision_in_worker": round((sum(busy) - reset_s) / (steps * n) * 1e6, 1),
            "resets": resets, "ms_per_reset": round(reset_s / max(resets, 1) * 1e3, 2),
            "episodes": n_eps, "episode_reasons": episodes,
            "success_rate": round(successes / judged, 3) if judged else None,
            "faults": env.fault_count - faults0, "worker_restarts": env.worker_restarts - restarts0,
            "worker_rss_mb": round(sum(a["rssBytes"] for a in after) / len(after) / 2**20, 1),
            "game": env.describe()["game"]["commit"][:7], "node": env.describe()["node"],
        }
    finally:
        env.close()
    if args.json:
        print(json.dumps(report))
    else:
        for key, value in report.items():
            print(f"{key:28s} {value}")
    return 0


def cmd_replay(args: argparse.Namespace) -> int:
    ok = True
    for path in args.transcripts:
        res = verify(path, game_dir=args.game_dir)
        ok = ok and bool(res.get("ok"))
        print(json.dumps(dict(res, file=path)))
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="bota-harness", description="Environment harness for The Binding of the Agent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info", help="verify the game checkout and print what an environment would record about itself")
    _env_args(p)
    p.set_defaults(fn=cmd_info)

    p = sub.add_parser("bench", help="random policy across all workers: throughput, reset cost, faults")
    _env_args(p)
    p.add_argument("--envs", type=int, default=4 * (os.cpu_count() or 1))
    p.add_argument("--workers", type=int, default=0, help="default: min(envs, CPU count)")
    p.add_argument("--secs", type=float, default=10.0)
    p.add_argument("--warmup", type=float, default=5.0)
    p.add_argument("--scenario", default="bug_room", choices=["bug_room", "full_run"])
    p.add_argument("--max-play-frames", type=int, default=3600)
    p.add_argument("--frame-skip", type=int, default=4)
    p.add_argument("--spin-wait", type=float, default=0.002)
    p.add_argument("--shared-code", action="store_true")
    p.add_argument("--probe", action="store_true")
    p.add_argument("--obs", default="v2", choices=["v2", "none"],
                   help="observation; with v2, full runs end as 'unreviewed' at the first unreviewed enemy")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_bench)

    p = sub.add_parser("replay", help="replay recorded episodes in Node and check their final state")
    p.add_argument("transcripts", nargs="+")
    p.add_argument("--game-dir", default=None)
    p.set_defaults(fn=cmd_replay)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
