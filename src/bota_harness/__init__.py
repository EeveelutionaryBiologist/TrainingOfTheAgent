"""Environment harness for The Binding of the Agent.

    from bota_harness import BotaVecEnv, TestRoom, ScenarioTask

    env = BotaVecEnv(num_envs=64, task=ScenarioTask(TestRoom(enemies=["bug", "bug"], max_play_frames=3600)))
    obs, info = env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
    env.close()
"""
from .env import BotaEnv
from .errors import (HarnessError, ResetError, ScenarioError, WorkerCrashed, WorkerFailure, WorkerRequestError,
                     WorkerStartError, WorkerTimeout)
from .protocol import ACTION_NVEC, MOVES, REASONS, SHOTS
from .scenario import FullRun, Player, Scenario, TestRoom, list_scenarios, load_scenario, random_seed
from .task import Columns, EpisodeResult, ReferenceTask, ScenarioTask, StepData, Task
from .vec_env import BotaVecEnv

__version__ = "0.2.0"

__all__ = [
    "ACTION_NVEC", "MOVES", "REASONS", "SHOTS",
    "BotaEnv", "BotaVecEnv",
    "FullRun", "Player", "Scenario", "TestRoom", "list_scenarios", "load_scenario", "random_seed",
    "Columns", "EpisodeResult", "ReferenceTask", "ScenarioTask", "StepData", "Task",
    "HarnessError", "ResetError", "ScenarioError", "WorkerCrashed", "WorkerFailure", "WorkerRequestError",
    "WorkerStartError", "WorkerTimeout",
]
