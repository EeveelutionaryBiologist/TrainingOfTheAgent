"""Task interface: what an episode is about (R12, R13).

A task decides three things and nothing else:
    scenario()  what the next episode of an environment sets up
    reward()    the reward of one decision, for all environments at once
    success()   whether a finished episode met the goal's own criterion (never derived from reward, R13)

Rewards are computed from the PRIVILEGED side channel: event counters and, if the task asks for it, the raw state
probe. Neither is part of the observation. Goal rewards live on the agent side (src/bota_agent); this package ships only the
neutral default and a small reference task for its tests.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from .protocol import REASONS
from .scenario import FullRun, Scenario, TestRoom


class Columns:
    """A (num_envs, n) array with named columns: `cols.kills`, `cols["kills"]`; `cols.array` is the whole block."""

    __slots__ = ("array", "names", "_index")

    def __init__(self, array: np.ndarray, names: Sequence[str]):
        self.array = array
        self.names = tuple(names)
        self._index = {n: i for i, n in enumerate(self.names)}

    def __getitem__(self, name: str) -> np.ndarray:
        return self.array[:, self._index[name]]

    def __getattr__(self, name: str) -> np.ndarray:
        try:
            return self.array[:, self._index[name]]
        except KeyError:
            raise AttributeError(f"no column {name!r}; columns: {', '.join(self.names)}") from None

    def __contains__(self, name: str) -> bool:
        return name in self._index

    def row(self, i: int) -> dict[str, float]:
        return {n: float(v) for n, v in zip(self.names, self.array[i])}


class StepData:
    """One decision of all environments, as the task sees it. All arrays have length num_envs.

    events       Columns: event counters of this decision (js/core/events.js)
    probe        Columns: raw state after the decision; None unless the probe is enabled
    terminated   bool array
    truncated    bool array
    reason       uint8 array, index into REASONS
    reset        bool array: this environment started a new episode in this call (its reward is forced to 0)
    """

    __slots__ = ("events", "probe", "terminated", "truncated", "reason", "reset")

    def __init__(self, events: Columns, probe: Columns | None, terminated: np.ndarray, truncated: np.ndarray,
                 reason: np.ndarray, reset: np.ndarray):
        self.events, self.probe = events, probe
        self.terminated, self.truncated, self.reason, self.reset = terminated, truncated, reason, reset

    def ended(self, reason: str) -> np.ndarray:
        """Mask of environments whose episode ended for `reason` in this decision."""
        return self.reason == REASONS.index(reason)


@dataclass(frozen=True)
class EpisodeResult:
    """Summary of a finished episode, handed to `Task.success` and reported in `info["result"]`."""

    env_index: int
    episode_index: int
    scenario: dict[str, Any]
    seed: str
    reason: str                      # one of REASONS
    terminated: bool
    truncated: bool
    play_frames: int                 # frames the agent could act in
    frames: int                      # all frames since the agent got control, transitions included
    decisions: int
    total_reward: float
    events: dict[str, float]         # event counters summed over the episode
    fault: dict[str, Any] | None = None
    success: bool | None = None      # the task's verdict; None if the task has no criterion


class Task:
    """Base class and neutral default: full runs from random seeds, reward 0, no success criterion."""

    name = "none"
    version: int | str = 0
    needs_probe = False              # True: the environment enables the raw state probe for reward()

    def scenario(self, rng: np.random.Generator, env_index: int, episode_index: int) -> Scenario:
        """Scenario of the next episode. Leave its seed empty to get one from the environment's generator."""
        return FullRun()

    def reward(self, step: StepData) -> np.ndarray | float:
        """Reward of this decision per environment: an array of length num_envs, or one number for all."""
        return 0.0

    def success(self, episode: EpisodeResult) -> bool | None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"name": self.name, "version": self.version}


class ScenarioTask(Task):
    """Always the same scenario (with a fresh seed each episode unless the scenario fixes one), reward 0."""

    name = "scenario"

    def __init__(self, scenario: Scenario):
        self._scenario = scenario

    def scenario(self, rng: np.random.Generator, env_index: int, episode_index: int) -> Scenario:
        return self._scenario


class ReferenceTask(Task):
    """Small test task, not a training target: a room with two Bugs, 60 s time limit.

    Reward: +1 per kill, -0.5 per half heart lost. Success: the room was cleared.
    """

    name = "reference_bug_room"
    version = 1

    def __init__(self, enemies: Sequence[str] = ("bug", "bug"), max_play_frames: int = 3600):
        self._scenario = TestRoom(enemies=tuple(enemies), max_play_frames=max_play_frames)

    def scenario(self, rng: np.random.Generator, env_index: int, episode_index: int) -> Scenario:
        return self._scenario

    def reward(self, step: StepData) -> np.ndarray:
        return step.events.kills - 0.5 * step.events.damage_taken

    def success(self, episode: EpisodeResult) -> bool:
        return episode.reason == "room_clear"
