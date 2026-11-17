"""The fair observation as it arrives in Python. What it may contain is tested on the Node side
(js/test/observe.test.js); here: transport, spaces, the review gate, and identity (R9)."""
from __future__ import annotations

import json
import os
import signal
from pathlib import Path

import numpy as np
import pytest

from bota_harness import REASONS, Player, ReferenceTask, ScenarioError, ScenarioTask, TestRoom
from conftest import noop, random_actions

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / "schema" / "obs_v1.json").read_text())


def col(env, field, name):
    return env.obs_columns[field].index(name)


def test_layout_is_the_frozen_schema_and_shapes_the_space(make_env, endless_task):
    env = make_env(3, endless_task, workers=2)
    assert env.obs_layout == SCHEMA
    d = env.describe()["obs"]
    assert (d["id"], d["version"], d["bytes"]) == ("v1", 1, SCHEMA["bytes"]) and len(d["layout_hash"]) == 16
    assert d["reviewed"]["enemies"] == ["bug", "null_pointer", "memory_leak", "leaklet"]
    obs, _ = env.reset(seed=0)
    assert list(obs) == [f["name"] for f in SCHEMA["fields"]]
    for f in SCHEMA["fields"]:
        assert obs[f["name"]].shape == (3, *f["shape"])
        assert obs[f["name"]].dtype == (np.float32 if f["dtype"] == "f4" else np.uint8)
    assert env.observation_space.contains(obs)
    assert env.single_observation_space["enemies"].shape == (32, len(env.obs_columns["enemies"]))
    assert env.obs_vocab["sprites"][0] == "enemy_bug" and "trapdoor" in env.obs_vocab["sprites"]


def test_values_match_the_game_and_each_step_returns_fresh_arrays(make_env, endless_task):
    env = make_env(4, endless_task, workers=2, probe=True)
    obs0, info = env.reset(seed=3)
    assert (obs0["player"][:, col(env, "player", "fresh")] == 1).all(), "nothing has moved yet"
    rng = np.random.default_rng(0)
    kept = []
    for _ in range(30):
        obs, _, _, _, info = env.step(random_actions(rng, 4))
        kept.append(obs)
    px, py = env.probe_names.index("player_x"), env.probe_names.index("player_y")
    assert np.array_equal(obs["player"][:, col(env, "player", "x")], info["probe"][:, px])
    assert np.array_equal(obs["player"][:, col(env, "player", "y")], info["probe"][:, py])
    assert np.array_equal(obs["player"][:, col(env, "player", "health")], info["probe"][:, env.probe_names.index("health")])
    assert (obs["enemy_mask"].sum(axis=1) == 2).all() and (obs["hud"][:, col(env, "hud", "enemies_total")] == 2).all()
    bug = env.obs_vocab["sprites"].index("enemy_bug") + 1
    assert (obs["enemies"][:, :2, col(env, "enemies", "type")] == bug).all()
    assert not obs["enemies"][:, 2:].any(), "padding rows are zero"
    assert (obs["tiles"][:, 0] == 1).sum() >= 4 * 14 and (obs["tiles"][:, 4, 7] == 0).all(), "walls around, floor inside"
    assert (obs["minimap"][:, 2, 3, 0] == 3).all(), "the current room is the centre of the map window"
    assert not np.shares_memory(kept[0]["player"], kept[1]["player"]) and not np.array_equal(kept[0]["player"], kept[-1]["player"])
    snap = env.snapshot(1)
    assert obs["player"][1, col(env, "player", "x")] == np.float32(snap["player"]["x"])


def test_observations_do_not_depend_on_the_process_layout(make_env):
    def run(workers):
        env = make_env(6, ReferenceTask(enemies=("bug", "bug", "null_pointer"), max_play_frames=240), workers=workers)
        obs, _ = env.reset(seed=21)
        out = [np.concatenate([v.reshape(6, -1).astype(np.float64) for v in obs.values()], axis=1)]
        rng = np.random.default_rng(4)
        for _ in range(200):
            obs, *_ = env.step(random_actions(rng, 6))
            out.append(np.concatenate([v.reshape(6, -1).astype(np.float64) for v in obs.values()], axis=1))
        return np.array(out)
    a, b = run(1), run(3)
    assert np.array_equal(a, b)
    assert len(np.unique(a[:, 0, :2], axis=0)) > 100, "and they are not constant"


def test_review_gate_refuses_scenarios_and_ends_episodes(make_env, endless_task):
    env = make_env(3, endless_task)
    for enemies, what in ((("hallucination",), "enemy:hallucination"), (("bug", "trojan"), "enemy:trojan"), (("jira_ticket",), "enemy:jira_ticket")):
        with pytest.raises(ScenarioError, match=f"no reviewed view for: {what}"):
            env.reset(seed=0, options={"scenario": TestRoom(enemies=enemies)})
    with pytest.raises(ScenarioError, match="enemy:monolith"):
        env.reset(seed=0, options={"scenario": TestRoom(boss="monolith")})

    env.reset(seed=0)
    env.step(noop(3))
    built = sum(s["instancesBuilt"] for s in env.worker_stats())
    env.call(1, "spawn", "jira_ticket")          # privileged: an unreviewed enemy appears in env 1
    obs, _, terminated, truncated, info = env.step(noop(3))
    assert list(truncated) == [False, True, False] and not terminated.any()
    assert info["reason"][1] == REASONS.index("unreviewed") == 8
    fault = info["fault"][1]
    assert fault["kind"] == "unreviewed" and fault["what"] == ["enemy:jira_ticket"] and fault["seed"] == env.scenarios[1]["seed"]
    assert info["result"][1].reason == "unreviewed"
    assert obs["enemy_mask"][1].sum() == 2, "the two Bugs are shown, the unreviewed enemy is not"
    obs, _, terminated, truncated, info = env.step(noop(3))
    assert list(info["reset"]) == [False, True, False] and not (terminated | truncated).any()
    assert env.worker_restarts == 0 and sum(s["instancesBuilt"] for s in env.worker_stats()) == built, "nothing was rebuilt"


def test_obs_none_is_a_placeholder_without_gate(make_env):
    env = make_env(2, ScenarioTask(TestRoom(enemies=("hallucination", "trojan"), end_on=(), player=Player(god=True))), obs="none")
    obs, _ = env.reset(seed=0)
    assert list(obs) == ["none"] and obs["none"].shape == (2, 1) and not obs["none"].any()
    assert env.describe()["obs"]["id"] == "none" and env.describe()["obs"]["version"] == 0
    obs, _, terminated, truncated, _ = env.step(noop(2))
    assert not (terminated | truncated).any() and env.observation_space.contains(obs)
    with pytest.raises(Exception, match="unknown observation"):
        make_env(1, obs="v7")


def test_after_a_fault_nothing_is_shown(make_env, endless_task):
    env = make_env(4, endless_task, workers=2, _test_hooks=True)
    env.reset(seed=1)
    env.step(noop(4))
    env.call(0, "__throw")
    os.kill(env.worker_pids[1], signal.SIGKILL)
    obs, _, _, truncated, info = env.step(noop(4))
    assert list(truncated) == [True, False, True, True]
    for name, arr in obs.items():
        assert not arr[0].any() and not arr[2].any() and not arr[3].any(), name
    assert obs["player"][1].any() and obs["tiles"][1].any(), "the healthy environment still sees its room"
    obs, *_ = env.step(noop(4))
    assert all(obs["tiles"][i].any() for i in range(4)), "new episodes are visible again"
