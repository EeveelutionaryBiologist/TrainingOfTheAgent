"""Task interface: scenarios, reward from privileged events, success criterion, episode results."""
from __future__ import annotations

import numpy as np
import pytest

from bota_harness import (REASONS, EpisodeResult, HarnessError, Player, ReferenceTask, ResetError, ScenarioError,
                          ScenarioTask, StepData, Task, TestRoom)
from conftest import ENDLESS, noop, random_actions


def test_reference_task_success_and_episode_result(make_env):
    env = make_env(2, ReferenceTask(), probe=True)
    env.reset(seed=4)
    env.step(noop(2))
    alive = env.probe_names.index("enemies_alive")
    env.call(0, "killAll")                       # privileged: ends env 0's fight at once
    _, reward, terminated, truncated, info = env.step(noop(2))
    assert list(terminated) == [True, False] and not truncated.any()
    assert info["reason"][0] == REASONS.index("room_clear")
    kills = info["events"][:, env.event_names.index("kills")]
    cleared = info["events"][:, env.event_names.index("rooms_cleared")]
    assert list(cleared) == [1.0, 0.0], "the game noticed the empty room during the decision"
    assert list(kills) == [0.0, 0.0] and not reward.any(), "what a control call did is not credited to the agent"
    assert info["probe"][0, alive] == 0 and info["probe"][1, alive] == 2
    res: EpisodeResult = info["result"][0]
    assert res.success is True and info["success"][0] and info["_success"][0] and not info["_success"][1]
    assert res.reason == "room_clear" and res.total_reward == 0.0
    assert res.events["kills"] == 0.0 and res.events["rooms_cleared"] == 1.0
    assert res.scenario["enemies"] == ["bug", "bug"] and res.scenario["maxPlayFrames"] == 3600


def test_reward_follows_the_events_and_death_is_not_success(make_env):
    task = ReferenceTask(enemies=("null_pointer",) * 8)
    env = make_env(3, task)
    env.reset(seed=9, options={"scenario": TestRoom(enemies=("null_pointer",) * 8, player=Player(health=1))})
    rng = np.random.default_rng(0)
    total = np.zeros(3)
    results = {}
    for _ in range(3000):
        _, reward, terminated, truncated, info = env.step(random_actions(rng, 3))
        ev = info["events"]
        expected = ev[:, env.event_names.index("kills")] - 0.5 * ev[:, env.event_names.index("damage_taken")]
        expected[info["reset"]] = 0.0
        assert np.allclose(reward, expected)
        first = [i for i in range(3) if i not in results]
        total[first] += reward[first]
        if "result" in info:
            for res in info["result"][info["_result"]]:
                results.setdefault(res.env_index, res)
        if len(results) == 3:
            break
    assert len(results) == 3
    deaths = [r for r in results.values() if r.reason == "death"]
    assert deaths, "one half heart against eight Null Pointers"
    for r in results.values():
        assert r.total_reward == pytest.approx(total[r.env_index])
        assert r.success is (r.reason == "room_clear")
    d = deaths[0]
    assert d.terminated and not d.truncated and d.events["deaths"] == 1.0 and d.events["damage_taken"] >= 1.0


def test_custom_task_sees_probe_and_controls_scenarios(make_env):
    class Custom(Task):
        name, version, needs_probe = "custom", 7, True

        def __init__(self):
            self.calls, self.steps = [], []

        def scenario(self, rng, env_index, episode_index):
            self.calls.append((env_index, episode_index))
            return TestRoom(enemies=("bug",), player=Player(god=True), end_on=(), max_play_frames=8,
                            seed=f"CUSTOM-{env_index}-{episode_index}")

        def reward(self, step: StepData):
            self.steps.append(step)
            return 0.25      # one number for all environments

        def success(self, episode):
            return episode.episode_index % 2 == 1

    task = Custom()
    env = make_env(2, task)
    assert env.probe_names, "needs_probe switched the probe on"
    assert env.describe()["task"] == {"name": "custom", "version": 7}
    env.reset(seed=0)
    assert task.calls == [(0, 0), (1, 0)]
    out = [env.step(noop(2)) for _ in range(6)]   # 2 decisions per episode, then a reset step
    rewards = np.array([o[1] for o in out])
    assert rewards[:, 0].tolist() == [0.25, 0.25, 0.0, 0.25, 0.25, 0.0], "the reset step pays nothing"
    assert task.calls == [(0, 0), (1, 0), (0, 1), (1, 1), (0, 2), (1, 2)]
    assert env.scenarios[1]["seed"] == "CUSTOM-1-2"
    assert [o[4]["success"][0] for o in out if "success" in o[4]] == [False, True]
    step = task.steps[0]
    assert step.probe.health.shape == (2,) and (step.probe.max_health >= step.probe.health).all()
    assert step.events.kills.shape == (2,) and "kills" in step.events and step.events["kills"] is not None
    assert step.ended("time_limit").tolist() == [False, False] and task.steps[1].ended("time_limit").all()
    with pytest.raises(AttributeError, match="no column"):
        step.events.no_such_counter

    class Bad(Task):
        def reward(self, step):
            return np.zeros(5)
    bad = make_env(2, Bad())
    bad.reset(seed=0)
    with pytest.raises(HarnessError, match="must return 2 values"):
        bad.step(noop(2))


def test_invalid_scenarios_are_refused_and_the_env_survives(make_env, endless_task):
    env = make_env(2, endless_task)
    for scenario, message in (
        (TestRoom(enemies=("no_such_enemy",)), "unknown enemy id"),
        ({"kind": "test_room", "enemies": ["bug"], "layout": "no_such_layout"}, "unknown layout id"),
        ({"kind": "full_run", "bogus": 1}, "unknown scenario field"),
        (TestRoom(enemies=("bug",), player=Player(items=("no_such_item",))), "unknown item id"),
        (TestRoom(), "needs enemies or a boss"),
    ):
        with pytest.raises(ScenarioError, match=message):
            env.reset(seed=0, options={"scenario": scenario})
    with pytest.raises(TypeError):
        env.reset(options={"scenario": "full_run"})
    env.reset(seed=0)
    assert (env.step(noop(2))[4]["play_frames"] == 4).all()
    assert env.fault_count == 0


def test_a_seed_that_does_not_fit_is_retried_with_another(make_env):
    # A test room behind one particular door: about half of all seeds have no usable room there
    env = make_env(1, ScenarioTask(ENDLESS))
    bad = None
    for k in range(40):
        try:
            env.reset(options={"scenario": TestRoom(seed=f"DOOR-{k}", enemies=("bug",), door="up")})
        except ResetError as err:
            bad = f"DOOR-{k}"
            assert "use another seed" in str(err) and "offers no other" in str(err)
            break
    assert bad, "expected at least one of 40 seeds to have no usable room behind the upper door"

    many = make_env(12, ScenarioTask(TestRoom(enemies=("bug",), door="up", player=Player(god=True), end_on=())), workers=3)
    _, info = many.reset(seed=1)          # seeds drawn by the env: unusable ones are replaced silently
    assert len({s["seed"] for s in info["scenario"]}) == 12
    assert all(many.snapshot(i)["room"]["enemies"] for i in range(12))
    assert many.fault_count == 0
