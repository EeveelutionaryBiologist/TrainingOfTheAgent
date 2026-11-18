"""The Gymnasium contract of BotaVecEnv and BotaEnv: spaces, shapes, autoreset, reset options."""
from __future__ import annotations

import numpy as np
import pytest
from gymnasium import spaces
from gymnasium.utils.env_checker import check_env
from gymnasium.vector import AutoresetMode

from bota_harness import (ACTION_NVEC, REASONS, BotaEnv, FullRun, HarnessError, Player, ScenarioTask,
                          TestRoom)
from conftest import ENDLESS, noop

SHORT = TestRoom(enemies=("bug",), player=Player(god=True), end_on=(), max_play_frames=40)   # 10 decisions


def test_spaces_and_description(make_env):
    env = make_env(3, workers=2)
    assert isinstance(env.single_action_space, spaces.MultiDiscrete)
    assert tuple(env.single_action_space.nvec) == ACTION_NVEC == (9, 5, 2, 2)
    assert env.action_space.shape == (3, 4)
    assert env.observation_space.contains(env.reset(seed=0)[0])
    d = env.describe()
    assert d["game"]["pinned"] is True and d["game"]["tag"] == "v1.0" and len(d["game"]["commit"]) == 40
    assert (d["obs"]["id"], d["obs"]["version"]) == ("v2", 2), "the fair observation is the default"
    assert d["profile"] == "lean" and d["det_math"] is True and d["frame_skip"] == 4
    assert d["workers"] == 2 and d["num_envs"] == 3 and d["task"] == {"name": "none", "version": 0}
    assert d["seed"] is not None
    assert "kills" in d["events"] and "damage_taken" in d["events"] and d["probe"] == []
    assert env.metadata["autoreset_mode"] is AutoresetMode.NEXT_STEP


def test_step_shapes_and_counters(make_env, endless_task):
    env = make_env(4, endless_task, workers=2, probe=True)
    obs, info = env.reset(seed=1)
    assert obs["player"].shape == (4, len(env.obs_columns["player"])) and obs["tiles"].shape == (4, 9, 15)
    assert info["scenario"].shape == (4,) and all(s["kind"] == "test_room" and s["seed"] for s in info["scenario"])
    assert info["probe"].shape == (4, len(env.probe_names))
    for t in range(1, 6):
        obs, reward, terminated, truncated, info = env.step(noop(4))
        assert reward.shape == (4,) and reward.dtype == np.float64 and not reward.any()
        assert terminated.dtype == np.bool_ and truncated.dtype == np.bool_ and not (terminated | truncated).any()
        assert (info["play_frames"] == 4 * t).all() and (info["decisions"] == t).all()
        assert info["events"].shape == (4, len(env.event_names))
        assert not info["reset"].any() and (info["reason"] == REASONS.index("none")).all()
        assert "result" not in info and "fault" not in info
    snap = env.snapshot(2)
    assert snap["state"] == "play" and snap["player"]["god"] is True
    assert snap["probe"]["player_x"] == pytest.approx(float(info["probe"][2, env.probe_names.index("player_x")]))


def test_next_step_autoreset(make_env):
    env = make_env(2, ScenarioTask(SHORT))
    _, info = env.reset(seed=5)
    first = [s["seed"] for s in info["scenario"]]
    for t in range(1, 10):
        _, _, terminated, truncated, info = env.step(noop(2))
        assert not (terminated | truncated).any()
    _, reward, terminated, truncated, info = env.step(noop(2))
    assert truncated.all() and not terminated.any()
    assert (info["reason"] == REASONS.index("time_limit")).all()
    assert info["_result"].all() and info["_success"].all() and not info["success"].any()
    res = info["result"][0]
    assert (res.reason, res.truncated, res.terminated, res.play_frames, res.decisions) == ("time_limit", True, False, 40, 10)
    assert res.seed == first[0] and res.episode_index == 0 and res.env_index == 0 and res.success is None
    assert res.fault is None

    # The call after the end starts the next episode: action ignored, reward 0, nothing done
    _, reward, terminated, truncated, info = env.step(np.array([[4, 4, 1, 1]] * 2))
    assert info["reset"].all() and not (terminated | truncated).any() and not reward.any()
    assert (info["play_frames"] == 0).all() and (info["decisions"] == 0).all() and not info["events"].any()
    second = [s["seed"] for s in env.scenarios]
    assert second != first and second[0] != second[1]
    _, _, _, _, info = env.step(noop(2))
    assert not info["reset"].any() and (info["play_frames"] == 4).all()


def test_seed_makes_scenarios_reproducible(make_env):
    def seeds(seed, workers):
        env = make_env(4, ScenarioTask(SHORT), workers=workers)
        env.reset(seed=seed)
        out = [tuple(s["seed"] for s in env.scenarios)]
        for _ in range(11):
            env.step(noop(4))
        out.append(tuple(s["seed"] for s in env.scenarios))
        return out
    a, b, c = seeds(11, 1), seeds(11, 4), seeds(12, 1)
    assert a == b, "scenario seeds depend on the reset seed, not on how the envs are spread over workers"
    assert a[0] != a[1] and a != c


def test_reset_options(make_env, endless_task):
    env = make_env(3, endless_task, workers=2)
    fixed = {"kind": "full_run", "seed": "OPT-ONE", "player": {"god": True}}
    _, info = env.reset(seed=0, options={"scenario": fixed})
    assert [s["seed"] for s in info["scenario"]] == ["OPT-ONE"] * 3
    assert all(env.snapshot(i)["seed"] == "OPT-ONE" for i in range(3))

    per_env = [FullRun(seed="OPT-A"), TestRoom(seed="OPT-B", enemies=("bug",)), fixed]
    env.reset(options={"scenario": per_env})
    assert [env.snapshot(i)["seed"] for i in range(3)] == ["OPT-A", "OPT-B", "OPT-ONE"]
    assert env.snapshot(1)["room"]["enemies"][0]["id"] == "bug"

    for _ in range(3):
        env.step(noop(3))
    mask = np.array([False, True, False])
    _, info = env.reset(options={"reset_mask": mask, "scenario": FullRun(seed="OPT-C")})
    assert list(info["_scenario"]) == [False, True, False] and info["scenario"][1]["seed"] == "OPT-C"
    _, _, _, _, info = env.step(noop(3))
    assert list(info["play_frames"]) == [16, 4, 16], "only the masked environment started over"

    with pytest.raises(ValueError, match="unknown reset options"):
        env.reset(options={"scenarios": fixed})
    with pytest.raises(ValueError, match="reset_mask"):
        env.reset(options={"reset_mask": np.array([True, False])})
    with pytest.raises(ValueError, match="needs 3 entries"):
        env.reset(options={"scenario": [fixed]})
    with pytest.raises(TypeError, match="seed must be an int"):
        env.reset(seed=[1, 2, 3])
    env.step(noop(3))   # still usable after refused calls


def test_disabled_autoreset(make_env):
    env = make_env(2, ScenarioTask(SHORT), autoreset_mode=AutoresetMode.DISABLED)
    assert env.metadata["autoreset_mode"] is AutoresetMode.DISABLED
    env.reset(seed=2, options={"scenario": [SHORT, ENDLESS]})
    for _ in range(10):
        _, _, _, truncated, _ = env.step(noop(2))
    assert list(truncated) == [True, False]
    with pytest.raises(HarnessError, match=r"environments \[0\] have no running episode"):
        env.step(noop(2))
    env.reset(options={"reset_mask": np.array([True, False]), "scenario": ENDLESS})
    _, _, _, truncated, info = env.step(noop(2))
    assert not truncated.any() and list(info["play_frames"]) == [4, 44]


def test_actions_are_validated_before_anything_moves(make_env, endless_task):
    env = make_env(2, endless_task)
    with pytest.raises(HarnessError, match="before reset"):
        env.step(noop(2))
    env.reset(seed=0)
    for bad, exc in (
        (np.zeros((3, 4), dtype=np.int64), ValueError),
        (np.zeros((2, 3), dtype=np.int64), ValueError),
        (np.array([[9, 0, 0, 0], [0, 0, 0, 0]]), ValueError),
        (np.array([[0, 5, 0, 0], [0, 0, 0, 0]]), ValueError),
        (np.array([[0, 0, 2, 0], [0, 0, 0, 0]]), ValueError),
        (np.array([[0, 0, 0, -1], [0, 0, 0, 0]]), ValueError),
        (np.zeros((2, 4), dtype=np.float32), TypeError),
    ):
        with pytest.raises(exc):
            env.step(bad)
    _, _, _, _, info = env.step(env.action_space.sample())
    assert (info["play_frames"] == 4).all(), "refused calls did not advance the game"


def test_frame_skip(make_env, endless_task):
    env = make_env(1, endless_task, frame_skip=8)
    env.reset(seed=0)
    _, _, _, _, info = env.step(noop(1))
    assert info["play_frames"][0] == 8 and env.describe()["frame_skip"] == 8


def test_close(make_env, endless_task):
    env = make_env(2, endless_task, workers=2)
    env.reset(seed=0)
    pids = env.worker_pids
    assert len(set(pids)) == 2
    env.close()
    env.close()
    for pid in pids:
        with pytest.raises(ProcessLookupError):
            import os
            os.kill(pid, 0)
    with pytest.raises(HarnessError, match="closed"):
        env.step(noop(2))


def test_single_env_passes_the_gymnasium_checker_and_has_no_autoreset():
    env = BotaEnv(ScenarioTask(SHORT), probe=True)
    try:
        check_env(env, skip_render_check=True)
        obs, info = env.reset(seed=3)
        assert obs["player"].ndim == 1 and obs["tiles"].shape == (9, 15) and env.observation_space.contains(obs)
        assert info["scenario"]["kind"] == "test_room" and info["probe"].ndim == 1
        for _ in range(9):
            obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
            assert isinstance(reward, float) and terminated is False and truncated is False
            assert "result" not in info
        _, _, terminated, truncated, info = env.step((0, 0, 0, 0))
        assert truncated is True and info["result"].reason == "time_limit"
        with pytest.raises(HarnessError, match="no running episode"):
            env.step((0, 0, 0, 0))
        env.reset()
        assert env.step((0, 0, 0, 0))[4]["play_frames"] == 4
        assert env.snapshot()["state"] == "play" and len(env.signature()) == 16
    finally:
        env.close()
    with pytest.raises(TypeError):
        BotaEnv(num_envs=2)
