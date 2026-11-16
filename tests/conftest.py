from __future__ import annotations

import numpy as np
import pytest

from bota_harness import ACTION_NVEC, BotaVecEnv, Player, ScenarioTask, TestRoom

NOOP = (0, 0, 0, 0)

#: Two Bugs, the player cannot die and the room never counts as cleared: episodes last until told otherwise
ENDLESS = TestRoom(enemies=("bug", "bug"), player=Player(god=True), end_on=(), max_play_frames=0)


def noop(n: int) -> np.ndarray:
    return np.zeros((n, 4), dtype=np.int64)


def random_actions(rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.integers(0, ACTION_NVEC, size=(n, 4))


@pytest.fixture
def make_env():
    """Factory for vector envs that are closed when the test ends."""
    made: list[BotaVecEnv] = []

    def make(num_envs: int = 2, task=None, **kwargs) -> BotaVecEnv:
        kwargs.setdefault("workers", 1)
        env = BotaVecEnv(num_envs, task, **kwargs)
        made.append(env)
        return env

    yield make
    for env in made:
        env.close()


@pytest.fixture
def endless_task() -> ScenarioTask:
    return ScenarioTask(ENDLESS)
