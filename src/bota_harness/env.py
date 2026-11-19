"""BotaEnv: one environment behind the plain Gymnasium API, for scripts, tests and debugging.

It is a thin front over a one-environment `BotaVecEnv` without autoreset: after an episode ends, call `reset()`.
For training use `BotaVecEnv` directly.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium.vector import AutoresetMode

from .task import Task
from .vec_env import BotaVecEnv


def _unbatch(info: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for key, value in info.items():
        if key.startswith("_"):
            continue
        mask = info.get("_" + key)
        if mask is not None and not mask[0]:
            continue
        out[key] = value[0]
    return out


class BotaEnv(gym.Env):
    """Single environment. Takes the same keyword arguments as `BotaVecEnv` (except num_envs and workers)."""

    metadata = {"render_modes": []}

    def __init__(self, task: Task | None = None, **kwargs: Any):
        for banned in ("num_envs", "workers", "autoreset_mode"):
            if banned in kwargs:
                raise TypeError(f"BotaEnv does not take {banned!r}")
        self.vec = BotaVecEnv(1, task, workers=1, autoreset_mode=AutoresetMode.DISABLED, **kwargs)
        self.action_space = self.vec.single_action_space
        self.observation_space = self.vec.single_observation_space

    def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None):
        """options["scenario"]: the scenario of this episode instead of the task's."""
        super().reset(seed=seed)
        obs, info = self.vec.reset(seed=seed, options=options)
        return {k: v[0] for k, v in obs.items()}, _unbatch(info)

    def step(self, action):
        obs, reward, terminated, truncated, info = self.vec.step(np.asarray(action)[None])
        return {k: v[0] for k, v in obs.items()}, float(reward[0]), bool(terminated[0]), bool(truncated[0]), _unbatch(info)

    def close(self) -> None:
        self.vec.close()

    # Privileged access, see BotaVecEnv
    def call(self, fn: str, *args: Any) -> Any:
        return self.vec.call(0, fn, *args)

    def snapshot(self) -> dict[str, Any]:
        return self.vec.snapshot(0)

    def signature(self) -> str:
        return self.vec.signature(0)

    def transcript(self) -> dict[str, Any]:
        return self.vec.transcript(0)

    def save_transcript(self, path: str | os.PathLike) -> Path:
        """Save the current or just finished episode's recording (needs record=True); `path` may be a folder."""
        return self.vec.save_transcript(0, path)

    def describe(self) -> dict[str, Any]:
        return self.vec.describe()
