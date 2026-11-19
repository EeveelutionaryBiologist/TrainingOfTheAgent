"""Scenarios: what a reset sets up (R3).

These dataclasses are a typed front for the JSON format that js/core/scenario.js defines and validates. A plain
dict in that format is accepted everywhere a scenario is. Leave `seed` empty to have the environment draw one
from its own seeded generator.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence, Union

import numpy as np

from .errors import ScenarioError
from .paths import scenario_dir

SEED_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
END_CONDITIONS = ("room_clear", "boss_kill", "floor_exit")


def random_seed(rng: np.random.Generator, length: int = 12) -> str:
    """A game seed (A-Z, 0-9) drawn from `rng`."""
    return "".join(SEED_ALPHABET[i] for i in rng.integers(0, len(SEED_ALPHABET), size=length))


@dataclass(frozen=True)
class Player:
    """Player setup. Health values count half hearts, as in the game. None keeps the game's default."""

    items: Sequence[str] = ()
    health: int | None = None
    max_health: int | None = None
    guardrails: int | None = None
    credits: int | None = None
    pushes: int | None = None
    approvals: int | None = None
    god: bool = False

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.items:
            out["items"] = list(self.items)
        for key, name in (("health", "health"), ("max_health", "maxHealth"), ("guardrails", "guardrails"),
                          ("credits", "credits"), ("pushes", "pushes"), ("approvals", "approvals")):
            value = getattr(self, key)
            if value is not None:
                out[name] = int(value)
        if self.god:
            out["god"] = True
        return out


def _common(sc: Any, kind: str) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind}
    if sc.seed:
        out["seed"] = str(sc.seed)
    if sc.depth != 1:
        out["depth"] = int(sc.depth)
    if sc.player is not None:
        player = sc.player.to_dict() if isinstance(sc.player, Player) else dict(sc.player)
        if player:
            out["player"] = player
    if sc.end_on is not None:
        out["endOn"] = list(sc.end_on)
    if sc.max_play_frames:
        out["maxPlayFrames"] = int(sc.max_play_frames)
    return out


@dataclass(frozen=True)
class FullRun:
    """A normal run from a seed, optionally starting on a deeper floor."""

    seed: str | None = None
    depth: int = 1
    player: Player | Mapping[str, Any] | None = None
    end_on: Sequence[str] | None = None        # extra end conditions: "boss_kill", "floor_exit"
    max_play_frames: int = 0                   # time limit in play frames, 0 = none

    def to_dict(self) -> dict[str, Any]:
        return _common(self, "full_run")


@dataclass(frozen=True)
class TestRoom:
    """A constructed fight: the room next to the start room is rebuilt and entered through its door."""

    __test__ = False   # not a pytest class

    seed: str | None = None
    depth: int = 1
    enemies: Sequence[Union[str, Mapping[str, Any]]] = ()   # ["bug", "bug"] or [{"id": "bug", "count": 2}]
    boss: str | None = None                                   # a boss id instead of enemies
    layout: str | Sequence[str] | None = None                 # layout id, "generated", or 7 rows of 13 chars
    door: str | None = None                                   # "up" | "right" | "down" | "left"
    player: Player | Mapping[str, Any] | None = None
    end_on: Sequence[str] | None = None                       # default: ("room_clear",)
    max_play_frames: int = 0

    def to_dict(self) -> dict[str, Any]:
        out = _common(self, "test_room")
        if self.enemies:
            out["enemies"] = [e if isinstance(e, str) else dict(e) for e in self.enemies]
        if self.boss:
            out["boss"] = self.boss
        if self.layout is not None:
            out["layout"] = self.layout if isinstance(self.layout, str) else {"rows": list(self.layout)}
        if self.door:
            out["door"] = self.door
        return out


Scenario = Union[FullRun, TestRoom, Mapping[str, Any]]


def _scenario_file(name_or_path: str | os.PathLike[str]) -> Path:
    path = Path(name_or_path)
    if path.suffix == ".json" or len(path.parts) > 1:
        return path
    return scenario_dir() / f"{name_or_path}.json"


def _read_scenario_file(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        known = ", ".join(sorted(p.stem for p in scenario_dir().glob("*.json"))) or "none"
        raise ScenarioError(f"no scenario file {path} (named scenarios: {known})") from None
    except json.JSONDecodeError as err:
        raise ScenarioError(f"{path} is not valid JSON: {err}") from None
    if not isinstance(data, dict) or "kind" not in data:
        raise ScenarioError(f"{path} does not hold a scenario (an object with a \"kind\")")
    return data


def load_scenario(name_or_path: str | os.PathLike[str]) -> dict[str, Any]:
    """A scenario from the scenarios/ folder by name ("single_bug"), or from a JSON file by path.

    The file holds the JSON form that js/core/scenario.js validates, plus an optional "description", which is
    dropped here. Validation itself happens in the worker at reset, like for any other scenario.
    """
    data = _read_scenario_file(_scenario_file(name_or_path))
    data.pop("description", None)
    return data


def list_scenarios() -> dict[str, str]:
    """Named scenarios in the scenarios/ folder: name → description."""
    out = {}
    for path in sorted(scenario_dir().glob("*.json")):
        out[path.stem] = str(_read_scenario_file(path).get("description", ""))
    return out


def to_dict(scenario: Scenario) -> dict[str, Any]:
    """The JSON form of a scenario (a copy, safe to modify)."""
    if isinstance(scenario, (FullRun, TestRoom)):
        return scenario.to_dict()
    if isinstance(scenario, Mapping):
        return dict(scenario)
    raise TypeError(f"a scenario is a FullRun, a TestRoom or a dict, not {type(scenario).__name__}")
