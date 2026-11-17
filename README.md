# BotA Environment Harness

Runs *The Binding of the Agent* without a browser, under program control, behind a Gymnasium vector API.
This repo is only the environment; training lives elsewhere. Requirements: `REQUIREMENTS.md`. Design and status:
`docs/TECHNICAL_PLAN.md`.

**Status:** Phases 0–3 are built (headless game, scenarios, recording, worker processes, Python API, task
interface, fair observation v1). The observation spec, `docs/observation-spec.md`, is awaiting review. Only four
enemies are reviewed so far (Bug, Null Pointer, Memory Leak, Leaklet); the rest of the game is behind the review
gate until Phase 4.

## Setup

- Node 22 or newer, Python 3.12 or newer, [uv](https://docs.astral.sh/uv/).
- The game checkout at the pinned version `v1.0` (`cc5cba4`), by default in `../BindingOfTheAgent`; set
  `BOTA_GAME_DIR` for another place. The harness refuses any other commit or a modified tree unless
  `allow_unpinned` / `BOTA_ALLOW_UNPINNED=1` is set, and records that it was.

```
uv sync
uv run bota-harness info        # verifies the checkout, prints what a run records about itself
npm test                        # JS suite
uv run pytest                   # Python suite
```

## Use

```python
import numpy as np
from bota_harness import BotaVecEnv, Task, TestRoom

class BugRoom(Task):
    name, version = "bug_room_demo", 1

    def scenario(self, rng, env_index, episode_index):
        return TestRoom(enemies=["bug", "bug"], max_play_frames=3600)   # seed left empty: the env draws one

    def reward(self, step):                                              # all environments at once
        return step.events.kills - 0.5 * step.events.damage_taken

    def success(self, episode):                                          # the goal's own criterion, not reward
        return episode.reason == "room_clear"

env = BotaVecEnv(num_envs=64, task=BugRoom())          # one worker process per core by default
obs, info = env.reset(seed=1)
for _ in range(1000):
    obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
    if "result" in info:                                # episodes that ended in this step
        for res in info["result"][info["_result"]]:
            print(res.seed, res.reason, res.success, res.total_reward)
env.close()
```

- **Observation:** a dict of fixed-shape arrays holding only what is on screen (`env.obs_layout`,
  `env.obs_columns`, `env.obs_vocab`). If a room holds something without a reviewed view, the episode ends as
  truncated with reason `unreviewed`. `obs="none"` gives a placeholder and no gate.
- **Actions:** `MultiDiscrete([9, 5, 2, 2])` = move (none + 8 directions), shoot (none + 4), Force Push, active
  item. Nothing else is reachable. One decision is held for `frame_skip` play frames (default 4).
- **Episodes end** by death, the scenario's end conditions (`room_clear`, `boss_kill`, `floor_exit`), its time
  limit, or a fault. Autoreset follows Gymnasium's next-step convention; `AutoresetMode.DISABLED` is available.
- **Reward side (privileged, never observation):** per-decision event counters (`step.events`, `info["events"]`)
  and an optional raw state probe (`probe=True`).
- **Faults:** a game error ends one episode as truncated; a dead or hung worker is replaced. Both are logged
  with seed and frame (`logging` logger `bota_harness`, `env.fault_log`).
- **Recording:** `BotaVecEnv(..., record=True)`, then `env.transcript(i)` after an episode ends;
  `uv run bota-harness replay file.json` checks it in Node. The same file replays in the browser.
- **Single environment:** `BotaEnv` (plain Gymnasium API, no autoreset) for scripts and debugging.

```
uv run bota-harness bench --envs 64 --workers 16     # random policy: throughput, reset cost, faults
node js/node/schema.js                               # the observation layout as JSON
```

## Layout

```
js/core/     game-facing code without Node dependencies: stepping, scenarios, env, observation, events, probe, recorder
schema/      frozen observation layouts, one file per version
js/node/     loader (pinned checkout), worker process, replay tool
src/bota_harness/   Python package: worker supervision, BotaVecEnv, BotaEnv, scenarios, Task interface, CLI
js/test/, tests/    node:test and pytest suites
bench/       Phase 0 checks and benchmarks
docs/        plan, results per phase
```
