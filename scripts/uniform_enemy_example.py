# RUN: uv run python uniform_enemy_example.py)
# REVIEW: uv run bota-harness view recordings/ --open [RECORDING]

import numpy as np
from bota_harness import BotaVecEnv, ScenarioTask, load_scenario
from bota_agent import UniformRandomPolicy

n = 4
env = BotaVecEnv(n, ScenarioTask(load_scenario("single_bug")), record=True)
policy = UniformRandomPolicy(seed=0)

obs, info = env.reset(seed=0)
state = policy.reset(policy.initial_state(n), np.ones(n, bool), [sc["seed"] for sc in env.scenarios])

saved = 0
while saved < 4:
    actions, state = policy.act(obs, state)
    obs, reward, terminated, truncated, info = env.step(actions)
    if "_result" in info:                                   # episodes that ended in this step
        for i in np.flatnonzero(info["_result"]):
            path = env.save_transcript(i, "recordings/")      # save now: the next step starts a new episode
            print(info["result"][i].reason, path)
            saved += 1
    if info["reset"].any():                                 # new episodes started: give the policy fresh state
        state = policy.reset(state, info["reset"], [sc["seed"] for sc in env.scenarios])
env.close()
