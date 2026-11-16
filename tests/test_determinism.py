"""Same seeds and actions give the same episodes, however the environments are spread over processes (N3)."""
from __future__ import annotations

import numpy as np
import pytest

from bota_harness import ReferenceTask, ScenarioTask, TestRoom, WorkerRequestError
from bota_harness.replay import verify
from conftest import ENDLESS, noop, random_actions


def trace(make_env, workers, steps=700, n=6, **kwargs):
    env = make_env(n, ReferenceTask(enemies=("bug", "null_pointer", "bug"), max_play_frames=480), workers=workers, probe=True, **kwargs)
    env.reset(seed=123)
    rng = np.random.default_rng(5)
    rows, ends = [], []
    for _ in range(steps):
        _, reward, terminated, truncated, info = env.step(random_actions(rng, n))
        rows.append(np.concatenate([reward, terminated, truncated, info["reason"], info["play_frames"], info["frames"],
                                    info["events"].ravel(), info["probe"].ravel()]))
        if "result" in info:
            ends += [(r.env_index, r.episode_index, r.seed, r.reason, r.play_frames, r.total_reward) for r in info["result"][info["_result"]]]
    return np.array(rows), ends, [env.signature(i) for i in range(n)]


def test_layout_independent(make_env):
    rows1, ends1, sig1 = trace(make_env, workers=1)
    rows3, ends3, sig3 = trace(make_env, workers=3)
    rows6, ends6, sig6 = trace(make_env, workers=6)
    assert len(ends1) >= 6, "the trace covers several episode ends and autoresets"
    assert np.array_equal(rows1, rows3) and np.array_equal(rows1, rows6)
    assert ends1 == ends3 == ends6
    assert sig1 == sig3 == sig6


def test_profile_and_code_sharing_do_not_change_trajectories(make_env):
    rows, ends, sig = trace(make_env, workers=2, steps=300)
    rows_full, ends_full, sig_full = trace(make_env, workers=2, steps=300, profile="full")
    rows_shared, ends_shared, sig_shared = trace(make_env, workers=2, steps=300, shared_code=True)
    assert np.array_equal(rows, rows_full) and sig == sig_full and ends == ends_full
    assert np.array_equal(rows, rows_shared) and sig == sig_shared


def test_recorded_episode_replays_in_node(make_env):
    env = make_env(2, ScenarioTask(TestRoom(enemies=("bug", "null_pointer"), max_play_frames=480)), record=True)
    env.reset(seed=8)
    rng = np.random.default_rng(2)
    done = {}
    while len(done) < 2:
        _, _, terminated, truncated, info = env.step(random_actions(rng, 2))
        for i in np.flatnonzero(terminated | truncated):
            # The recording of a finished episode stays available until the next step starts a new one
            done.setdefault(int(i), (env.transcript(int(i)), info["result"][i]))
    for i, (t, res) in done.items():
        assert t["format"] == 1 and t["scenario"]["seed"] == res.seed and t["tampered"] is False
        assert t["result"]["reason"] == res.reason and t["result"]["playFrames"] == res.play_frames
        assert t["meta"]["game"]["commit"] == env.describe()["game"]["commit"] and t["meta"]["detMath"] is True
        out = verify(t)
        assert out["ok"] is True and out["frames"] == t["endFrame"], out
    t = done[0][0]
    flipped = dict(t, codes=[{"KeyA": "KeyD", "KeyD": "KeyA"}.get(c, c) for c in t["codes"]])
    assert verify(flipped)["ok"] is False, "a changed input is noticed"


def test_control_calls_mark_the_recording_as_tampered(make_env):
    env = make_env(1, ScenarioTask(ENDLESS), record=True)
    env.reset(seed=0)
    env.step(noop(1))
    env.snapshot(0)
    env.signature(0)
    assert env.transcript(0)["tampered"] is False, "reading does not count"
    with pytest.raises(WorkerRequestError, match="unknown control call"):
        env.call(0, "handleKeys")
    with pytest.raises(WorkerRequestError, match="unknown control call"):
        env.call(0, "__throw")              # the fault-injection hooks are off unless a test enables them
    with pytest.raises(WorkerRequestError, match="unknown item id"):
        env.call(0, "giveItem", "no_such_item")
    assert env.transcript(0)["tampered"] is False, "refused calls change nothing"
    env.call(0, "resources", 5)
    assert env.snapshot(0)["player"]["pushes"] == 5
    env.step(noop(1))
    assert env.transcript(0)["tampered"] is True
    env.step(noop(1))
    env.reset()
    env.step(noop(1))
    assert env.transcript(0)["tampered"] is False, "a new episode starts clean"
