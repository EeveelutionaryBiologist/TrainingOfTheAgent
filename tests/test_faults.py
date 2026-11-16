"""R6 and N4: game errors, dead workers and hung workers end single episodes; the run goes on."""
from __future__ import annotations

import logging
import os
import signal
import time

import numpy as np
import pytest

from bota_harness import (REASONS, BotaVecEnv, HarnessError, Player, ScenarioTask, TestRoom, WorkerStartError)
from conftest import ENDLESS, noop, random_actions

FAULT = REASONS.index("fault")


def test_game_exception_ends_one_episode_and_is_logged(make_env, endless_task, caplog):
    env = make_env(4, endless_task, workers=2, _test_hooks=True)
    env.reset(seed=1)
    for _ in range(3):
        env.step(noop(4))
    seed = env.scenarios[2]["seed"]
    env.call(2, "__throw")
    with caplog.at_level(logging.WARNING, logger="bota_harness"):
        _, reward, terminated, truncated, info = env.step(noop(4))
    assert list(truncated) == [False, False, True, False] and not terminated.any()
    assert info["reason"][2] == FAULT and list(info["_fault"]) == [False, False, True, False]
    fault = info["fault"][2]
    assert fault["kind"] == "exception" and "injected exception" in fault["message"] and "injected" in fault["stack"]
    assert fault["seed"] == seed and fault["state"] == "play" and fault["frame"] > 0
    res = info["result"][2]
    assert res.reason == "fault" and res.fault is fault and res.truncated and not res.terminated
    assert env.fault_count == 1 and env.fault_log[0]["env_index"] == 2 and env.fault_log[0]["seed"] == seed
    assert any("env 2" in r.message and seed in r.message and "injected exception" in r.message for r in caplog.records)
    assert list(info["play_frames"]) == [16, 16, 12, 16], "the others finished their decision; the failed frame does not count"

    _, _, terminated, truncated, info = env.step(noop(4))
    assert list(info["reset"]) == [False, False, True, False] and not (terminated | truncated).any()
    assert "fault" not in info
    for _ in range(5):
        _, _, terminated, truncated, info = env.step(noop(4))
    assert not (terminated | truncated).any() and list(info["play_frames"]) == [40, 40, 20, 40]
    assert env.worker_restarts == 0, "a game error costs one game instance, not the worker"
    assert sum(s["instancesBuilt"] for s in env.worker_stats()) == 5


def test_error_the_game_swallows_and_logs_is_a_fault_too(make_env, endless_task):
    env = make_env(2, endless_task, _test_hooks=True)
    env.reset(seed=1)
    env.call(0, "__consoleError")
    _, _, _, truncated, info = env.step(noop(2))
    assert list(truncated) == [True, False]
    assert info["fault"][0]["kind"] == "console" and "injected listener error" in info["fault"][0]["message"]

    lenient = make_env(1, endless_task, _test_hooks=True, console_faults="off")
    lenient.reset(seed=1)
    lenient.call(0, "__consoleError")
    assert not lenient.step(noop(1))[3].any()


def test_killed_worker_is_replaced(make_env, endless_task, caplog):
    env = make_env(6, endless_task, workers=3)
    env.reset(seed=2)
    for _ in range(4):
        env.step(noop(6))
    pids = env.worker_pids
    os.kill(pids[1], signal.SIGKILL)
    with caplog.at_level(logging.WARNING, logger="bota_harness"):
        _, reward, terminated, truncated, info = env.step(noop(6))
    assert list(truncated) == [False, False, True, True, False, False] and not terminated.any()
    assert list(info["_fault"]) == list(truncated)
    fault = info["fault"][3]
    assert fault["kind"] == "worker_crash" and fault["worker"] == 1 and fault["pid"] == pids[1]
    assert fault["seed"] == info["result"][3].seed
    assert list(info["play_frames"]) == [20, 20, 16, 16, 20, 20], "the other workers' environments kept going"
    assert env.worker_restarts == 1 and env.fault_count == 2
    new = env.worker_pids
    assert new[0] == pids[0] and new[2] == pids[2] and new[1] != pids[1]
    assert any("worker 1" in r.message and "replaced" in r.message for r in caplog.records)

    _, _, terminated, truncated, info = env.step(noop(6))
    assert list(info["reset"]) == [False, False, True, True, False, False] and not (terminated | truncated).any()
    rng = np.random.default_rng(0)
    for _ in range(50):
        _, _, terminated, truncated, info = env.step(random_actions(rng, 6))
    assert not (terminated | truncated).any() and list(info["play_frames"]) == [224, 224, 200, 200, 224, 224]


def test_hung_game_loop_is_detected_and_the_worker_replaced(make_env, endless_task):
    env = make_env(4, endless_task, workers=2, step_timeout=1.5, _test_hooks=True)
    env.reset(seed=3)
    env.step(noop(4))
    env.call(3, "__hang")            # the game's update never returns: only killing the process helps
    t0 = time.monotonic()
    _, _, terminated, truncated, info = env.step(noop(4))
    waited = time.monotonic() - t0
    assert 1.4 < waited < 6.0
    assert list(truncated) == [False, False, True, True]
    assert info["fault"][2]["kind"] == info["fault"][3]["kind"] == "worker_hang"
    assert env.worker_restarts == 1
    _, _, terminated, truncated, info = env.step(noop(4))
    assert list(info["reset"]) == [False, False, True, True] and not (terminated | truncated).any()


def test_stopped_worker_counts_as_hung(make_env, endless_task):
    env = make_env(2, endless_task, workers=2, step_timeout=1.0)
    env.reset(seed=3)
    env.step(noop(2))
    stopped = env.worker_pids[0]
    os.kill(stopped, signal.SIGSTOP)
    _, _, _, truncated, info = env.step(noop(2))
    assert list(truncated) == [True, False] and info["fault"][0]["kind"] == "worker_hang"
    with pytest.raises(ProcessLookupError):
        os.kill(stopped, 0)
    assert not env.step(noop(2))[3].any()


def test_worker_dying_while_its_envs_reset(make_env):
    short = TestRoom(enemies=("bug",), player=Player(god=True), end_on=(), max_play_frames=8)
    env = make_env(4, ScenarioTask(short), workers=2)
    env.reset(seed=4, options={"scenario": [short, ENDLESS, short, ENDLESS]})
    env.step(noop(4))
    _, _, _, truncated, _ = env.step(noop(4))
    assert list(truncated) == [True, False, True, False]
    os.kill(env.worker_pids[1], signal.SIGKILL)
    # Env 2 was about to start a new episode, env 3 was in the middle of one
    _, _, terminated, truncated, info = env.step(noop(4))
    assert list(info["reset"]) == [True, False, True, False], "env 2 started its episode on the new worker"
    assert list(truncated) == [False, False, False, True] and info["fault"][3]["kind"] == "worker_crash"
    assert list(info["_fault"]) == [False, False, False, True]
    _, _, terminated, truncated, info = env.step(noop(4))
    assert list(info["reset"]) == [False, False, False, True]
    assert list(info["play_frames"]) == [4, 16, 4, 0]


def test_worker_dying_during_reset(make_env, endless_task):
    env = make_env(4, endless_task, workers=2)
    env.reset(seed=5)
    env.step(noop(4))
    os.kill(env.worker_pids[0], signal.SIGKILL)
    _, info = env.reset(seed=6)
    assert env.worker_restarts == 1 and info["_scenario"].all() and "fault" not in info
    assert (env.step(noop(4))[4]["play_frames"] == 4).all()

    # Partial reset: the dead worker also held a running episode that nobody asked to reset
    os.kill(env.worker_pids[1], signal.SIGKILL)
    _, info = env.reset(options={"reset_mask": np.array([False, False, True, False])})
    assert list(info["_fault"]) == [False, False, False, True] and info["fault"][3]["kind"] == "worker_crash"
    _, _, terminated, truncated, info = env.step(noop(4))
    assert list(info["reset"]) == [False, False, False, True] and not (terminated | truncated).any()
    assert list(info["play_frames"]) == [8, 8, 4, 0]


def test_a_worker_that_keeps_failing_stops_the_run(make_env, endless_task):
    env = make_env(2, endless_task, workers=2, max_worker_restarts=0)
    env.reset(seed=0)
    os.kill(env.worker_pids[0], signal.SIGKILL)
    with pytest.raises(HarnessError, match="failed 1 times in a row"):
        env.step(noop(2))


def test_start_errors_are_reported_with_their_cause(tmp_path):
    with pytest.raises(WorkerStartError, match="not a usable git checkout"):
        BotaVecEnv(1, game_dir=tmp_path)
    with pytest.raises(WorkerStartError, match="not found"):
        BotaVecEnv(1, node="no-such-node-binary")
    with pytest.raises(ValueError, match="workers must be in"):
        BotaVecEnv(2, workers=3)
    with pytest.raises(WorkerStartError, match="frameSkip"):
        BotaVecEnv(1, frame_skip=0)


def test_r11_action_space_cannot_pause_restart_or_cheat(make_env):
    # Every action combination, many times, on a full run. Pause would stop the game clock; restart would change
    # the run; debug keys would change resources. The JS suite checks the key codes themselves (js/test/input.test.js).
    env = make_env(3, ScenarioTask({"kind": "full_run", "seed": "PY-FUZZ-1", "player": {"god": True, "pushes": 0}}), probe=True)
    env.reset(seed=0)
    grid = np.array([[m, s, p, a] for m in range(9) for s in range(5) for p in range(2) for a in range(2)])
    rng = np.random.default_rng(3)
    before = env.snapshot(0)
    for t in range(400):
        _, _, terminated, truncated, info = env.step(grid[rng.integers(0, len(grid), size=3)])
        assert not (terminated | truncated).any()
    t_index = env.probe_names.index("run_time")
    for i in range(3):
        snap = env.snapshot(i)
        assert snap["state"] == "play" and snap["seed"] == "PY-FUZZ-1" and snap["player"]["god"] is True
        assert snap["player"]["pushes"] == 0 and snap["player"]["credits"] == before["player"]["credits"]
        assert snap["player"]["items"] == before["player"]["items"]
        assert info["probe"][i, t_index] == pytest.approx(info["play_frames"][i] / 60, abs=1e-3), "the clock never stopped"
