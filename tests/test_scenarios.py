"""Named scenarios (scenarios/*.json) as Python sees them: listing, loading, and running one through the env.
What each scenario sets up is tested on the Node side (js/test/scenarios.test.js)."""
from __future__ import annotations

import json

import pytest

from bota_harness import ScenarioError, ScenarioTask, list_scenarios, load_scenario
from conftest import noop


def test_list_and_load():
    named = list_scenarios()
    assert "single_bug" in named and "Bug" in named["single_bug"]
    sc = load_scenario("single_bug")
    assert sc == {"kind": "test_room", "depth": 1, "layout": "empty", "enemies": ["bug"],
                  "endOn": ["room_clear"], "maxPlayFrames": 3600}, "description dropped, nothing added"
    assert load_scenario("single_bug") is not sc, "a fresh copy each time"


def test_load_by_path_and_errors(tmp_path):
    f = tmp_path / "two_leaks.json"
    f.write_text(json.dumps({"description": "x", "kind": "test_room", "enemies": [{"id": "memory_leak", "count": 2}]}))
    assert load_scenario(f) == {"kind": "test_room", "enemies": [{"id": "memory_leak", "count": 2}]}
    assert load_scenario(str(f))["kind"] == "test_room"
    with pytest.raises(ScenarioError, match="single_bug"):
        load_scenario("no_such_scenario")                 # the message lists what exists
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    with pytest.raises(ScenarioError, match="not valid JSON"):
        load_scenario(bad)
    bad.write_text(json.dumps({"enemies": ["bug"]}))
    with pytest.raises(ScenarioError, match="kind"):
        load_scenario(bad)


def test_single_bug_runs_in_the_vector_env(make_env):
    env = make_env(4, ScenarioTask(load_scenario("single_bug")), workers=2)
    obs, info = env.reset(seed=11)
    assert (obs["enemy_mask"].sum(axis=1) == 1).all(), "one enemy in every env"
    bug = env.obs_vocab["sprites"].index("enemy_bug") + 1
    assert (obs["enemies"][:, 0, env.obs_columns["enemies"].index("type")] == bug).all()
    seeds = {sc["seed"] for sc in env.scenarios}
    assert len(seeds) == 4, "each env got its own floor"
    reasons = set()
    for _ in range(901):                                  # 60 s of play at frame-skip 4, plus the autoreset step
        _, _, _, _, info = env.step(noop(4))
        if "result" in info:
            reasons |= {r.reason for r in info["result"][info["_result"]]}
    assert reasons and reasons <= {"time_limit", "death"}, reasons
