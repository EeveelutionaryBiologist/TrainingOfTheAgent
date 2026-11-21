
import numpy as np
from bota_harness import BotaVecEnv, ScenarioTask, load_scenario

env = BotaVecEnv(4, ScenarioTask(load_scenario("single_bug")), record=True)
env.reset(seed=0)
saved = 0
while saved < 4:
    _, _, _, _, info = env.step(env.action_space.sample())
    if "_result" in info:
        for i in np.flatnonzero(info["_result"]):
            print(env.save_transcript(i, "recordings/"))   # call it in the step the episode ended
            saved += 1
env.close()