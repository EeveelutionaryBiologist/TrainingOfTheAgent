# Using the harness

How to run *The Binding of the Agent* from Python: set up, define what an episode is, step environments, read
observations and rewards, record episodes and watch them. For why things are the way they are, see
`REQUIREMENTS.md` and `docs/TECHNICAL_PLAN.md`; for what the observation contains, `docs/observation-spec.md`.

- [Setup](#setup)
- [First run](#first-run)
- [Scenarios: what an episode sets up](#scenarios-what-an-episode-sets-up)
- [Tasks: reward and success](#tasks-reward-and-success)
- [Stepping](#stepping)
- [Observation](#observation)
- [Recording and watching episodes](#recording-and-watching-episodes)
- [Faults](#faults)
- [Privileged access](#privileged-access)
- [Baselines and evaluation](#baselines-and-evaluation)
- [Command line](#command-line)
- [Using it from Node](#using-it-from-node)
- [Checks and benchmarks](#checks-and-benchmarks)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Setup

Needs Node 22 or newer, Python 3.12 or newer, and [uv](https://docs.astral.sh/uv/).

The game is not part of this repo. The harness loads it from a local checkout at the pinned version `v1.0`
(commit `cc5cba4`), by default `../BindingOfTheAgent` next to this repo:

```
git clone https://github.com/EeveelutionaryBiologist/BindingOfTheAgent ../BindingOfTheAgent
git -C ../BindingOfTheAgent checkout v1.0
```

The harness refuses any other commit and any local change to the game's `index.html` or `src/`. Set
`BOTA_GAME_DIR` to use a checkout somewhere else.

```
uv sync                         # Python environment
uv run bota-harness info        # verifies the checkout; prints what a run records about itself
npm test                        # JS suite (about 10 s)
uv run pytest                   # Python suite (about 30 s)
```

`bota_harness` is installed only in the project's environment (`.venv`), so run your own scripts with
`uv run python script.py` from the repo folder (from elsewhere: `uv run --project <repo> python script.py`, or
activate it with `source <repo>/.venv/bin/activate`). A plain `python script.py` fails with `ModuleNotFoundError`.

## First run

```python
import numpy as np
from bota_harness import BotaVecEnv, ScenarioTask, load_scenario

env = BotaVecEnv(num_envs=16, task=ScenarioTask(load_scenario("single_bug")))
obs, info = env.reset(seed=0)
for _ in range(2000):
    actions = env.action_space.sample()                       # shape (16, 4)
    obs, reward, terminated, truncated, info = env.step(actions)
    if "result" in info:                                      # episodes that ended in this step
        for res in info["result"][info["_result"]]:
            print(res.env_index, res.seed, res.reason, res.decisions)
env.close()
```

`BotaVecEnv` starts one Node worker process per CPU core (at most one per environment) and spreads the
environments over them. `num_envs=1` works too. For a plain single environment there is `BotaEnv` (below).

## Scenarios: what an episode sets up

A scenario is what `reset` builds. There are two kinds:

| Kind | Python | What it does |
|---|---|---|
| Full run | `FullRun(seed=None, depth=1, player=None, end_on=None, max_play_frames=0)` | A normal run from a seed, optionally starting on a deeper floor. |
| Test room | `TestRoom(seed=None, depth=1, enemies=(), boss=None, layout=None, door=None, player=None, end_on=None, max_play_frames=0)` | A constructed fight. The real floor is generated from the seed, the room next to the start room is rebuilt, and the player walks in through the door, so doors close, enemies wake up and the clear event fires as in a real fight. |

Fields:

- `seed`: leave it empty. The environment then draws a fresh seed per episode from its own generator, which
  `reset(seed=...)` seeds. Fix it only to replay one particular floor.
- `depth`: start floor, 1–99.
- `player`: `Player(items=(), health=None, max_health=None, guardrails=None, credits=None, pushes=None,
  approvals=None, god=False)`. Health counts half hearts; `None` keeps the game's default.
- `end_on`: end conditions besides death: `"room_clear"` (test rooms only, the default for them), `"boss_kill"`,
  `"floor_exit"`.
- `max_play_frames`: time limit in frames the agent can act in (60 per second); 0 means none.
- `enemies` (test room): `["bug", "bug"]` or `[{"id": "bug", "count": 2}]`, at most 40.
- `boss` (test room): a boss id instead of enemies. The room becomes a boss room with intro, boss bar and trapdoor.
- `layout` (test room): `"empty"` (default), a layout id of the game (e.g. `"special_pillars"`), `"generated"`
  (whatever the floor rolled for that room), or 7 strings of 13 characters: `.` floor, `r` rock, `b` block,
  `p` pit, `s` spikes, `e` floor with an enemy spawn point. The game's own layout check must accept it.
- `door` (test room): which door of the start room to use, `"up"`, `"right"`, `"down"` or `"left"`.

A plain dict in the JSON form works wherever a scenario is accepted (`{"kind": "test_room", "enemies": ["bug"],
"maxPlayFrames": 3600}`; keys are camelCase there). The format is defined at the top of `js/core/scenario.js`.

### Named scenarios

`scenarios/` holds one JSON file per scenario, in that format plus an optional `description`:

```python
from bota_harness import list_scenarios, load_scenario
list_scenarios()                     # {"single_bug": "One Bug in an empty room on floor 1. ..."}
sc = load_scenario("single_bug")     # a dict; also accepts a path to any JSON file
```

To add one, drop a file into `scenarios/`. The tests start every file in that folder once
(`js/test/scenarios.test.js`).

### What can appear in a room

Only content with a reviewed view in the observation may appear: Bug, Null Pointer, Memory Leak, Leaklet,
projectiles, bombs, all pickups, trapdoor, pipe, props. A scenario that sets up anything else is refused with
`ScenarioError`, and an episode in which something else turns up ends as `unreviewed` (see
[Observation](#observation)). A full run therefore usually ends at the first room with other enemies. With
`obs="none"` there is no such restriction.

## Tasks: reward and success

A task decides what each episode sets up, the reward of each decision and whether a finished episode met the goal.

```python
import numpy as np
from bota_harness import BotaVecEnv, Task, TestRoom

class BugRoom(Task):
    name, version = "bug_room", 1          # recorded with every run

    def scenario(self, rng, env_index, episode_index):
        return TestRoom(enemies=["bug", "bug"], max_play_frames=3600)

    def reward(self, step):                # one call for all environments; return an array or one number
        return step.events.kills - 0.5 * step.events.damage_taken

    def success(self, episode):            # the goal's own criterion, never derived from reward
        return episode.reason == "room_clear"

env = BotaVecEnv(64, BugRoom())
```

- `scenario(rng, env_index, episode_index)`: called for every new episode of every environment. `rng` is that
  environment's NumPy generator; use it for curricula or randomised setups.
- `reward(step)`: `step.events` holds the event counters of this decision (below), `step.probe` the raw state
  probe if the task sets `needs_probe = True`, and `step.terminated`, `step.truncated`, `step.reason`,
  `step.reset` are arrays over the environments. `step.ended("room_clear")` gives a mask. The reward of an
  environment that just started a new episode is forced to 0.
- `success(episode)`: receives an `EpisodeResult` (below). Return `None` for "no criterion".

Ready-made: `Task()` (full runs, reward 0), `ScenarioTask(scenario)` (always that scenario, reward 0),
`ReferenceTask()` (two Bugs, the test fixture). Goal rewards belong on the agent side (`src/bota_agent`).

### Event counters

Counted from the game's own event bus over exactly the frames of one decision. They are **privileged**: for
rewards, never part of the observation.

`damage_taken`, `hits_taken`, `damage_dealt`, `hits_dealt`, `kills`, `boss_kills`, `rooms_entered` (first
visits), `rooms_cleared`, `pickups`, `items`, `purchases`, `chests`, `floor_exits`, `cycles`, `shots`, `pushes`,
`actives`, `denied` (an action the game refused), `secrets`, `unlocks`, `deaths`. Damage is in half hearts.
`env.event_names` lists them in order.

### Raw state probe

With `needs_probe = True` on the task (or `probe=True` on the env), `step.probe` and `info["probe"]` carry 26 raw
values after each decision: player position, health, resources, item count, active charge, floor, room position
and type, whether the room is cleared, enemies alive, summed enemy and boss hit points, projectile and pickup
counts, run statistics, score. `env.probe_names` lists them. Also privileged.

## Stepping

### Actions

`MultiDiscrete([9, 5, 2, 2])`, one row per environment:

| Head | Values |
|---|---|
| move | 0 none, 1 up, 2 down, 3 left, 4 right, 5 up-left, 6 up-right, 7 down-left, 8 down-right |
| shoot | 0 none, 1 up, 2 down, 3 left, 4 right |
| Force Push | 0 / 1 (pressed for one frame at the start of the decision) |
| active item | 0 / 1 (likewise) |

These are the game's keys and nothing else; pause, restart and debug keys cannot be reached. One decision is
held for `frame_skip` frames of play (default 4, i.e. 15 decisions per second). Screens where the agent cannot
act (floor card, room transitions, boss intro) are stepped through inside the same `step` call.

### Ends of episodes

| `reason` | terminated / truncated | When |
|---|---|---|
| `death` | terminated | the player died |
| `room_clear` | terminated | the test room was cleared (`end_on`) |
| `boss_kill` | terminated | a boss room was cleared (`end_on`) |
| `floor_exit` | terminated | the player took the trapdoor (`end_on`) |
| `cycle_end` | terminated | the run reached its score card (the final boss is beaten) |
| `time_limit` | truncated | `max_play_frames` reached |
| `fault` | truncated | the game threw or logged an error, or its worker died or hung ([Faults](#faults)) |
| `unreviewed` | truncated | something without a reviewed view appeared in the room |

### Autoreset

The default is Gymnasium's next-step autoreset: the step after an episode ended resets that environment, returns
its first observation with reward 0 and `info["reset"][i] == True`, and ignores the action given for it. With
`autoreset_mode=AutoresetMode.DISABLED` nothing resets by itself; call
`env.reset(options={"reset_mask": mask})` for the finished ones.

`reset` also takes `options={"scenario": ...}`: one scenario for all environments, or a list with one per
environment, used instead of the task's for that reset.

### What `info` holds after a step

| Key | Shape | Content |
|---|---|---|
| `reason` | (n,) uint8 | index into `bota_harness.REASONS`; 0 while running |
| `reset` | (n,) bool | the environment started a new episode in this step |
| `events` | (n, 21) | event counters of this decision |
| `play_frames`, `frames`, `decisions` | (n,) | counters of the current episode |
| `probe` | (n, 26) | only with the probe enabled |
| `result`, `_result` | (n,) object, bool | `EpisodeResult` of each episode that ended in this step |
| `success`, `_success` | (n,) bool | the task's verdict for those episodes |
| `fault`, `_fault` | (n,) object, bool | fault records ([Faults](#faults)) |

`EpisodeResult` fields: `env_index`, `episode_index`, `scenario` (the dict that ran, seed included), `seed`,
`reason`, `terminated`, `truncated`, `play_frames`, `frames`, `decisions`, `total_reward`, `events` (summed over
the episode), `fault`, `success`.

### Single environment

```python
from bota_harness import BotaEnv, ScenarioTask, load_scenario
env = BotaEnv(ScenarioTask(load_scenario("single_bug")))
obs, info = env.reset(seed=1)
obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
```

Plain Gymnasium API, no autoreset: call `reset()` after an episode ends. Takes the same keyword arguments as
`BotaVecEnv` except `num_envs`, `workers` and `autoreset_mode`.

### Options of `BotaVecEnv`

| Option | Default | Meaning |
|---|---|---|
| `workers` | min(num_envs, CPU count) | Node processes |
| `frame_skip` | 4 | play frames per decision |
| `obs` | `"v2"` | the fair observation, or `"none"` (placeholder, no review gate; for benchmarks and reward work) |
| `probe` | task's `needs_probe` | include the raw state probe |
| `record` | False | keep key events so episodes can be saved and replayed |
| `autoreset_mode` | `NEXT_STEP` | or `DISABLED` |
| `profile` | `"lean"` | `"full"` also loads sound and particle code; identical trajectories |
| `det_math` | True | engine-independent math; needed for browser replays to match |
| `game_dir` | `$BOTA_GAME_DIR` or `../BindingOfTheAgent` | game checkout |
| `allow_unpinned` | False | run a checkout that is not `v1.0` (recorded in `describe()`) |
| `console_faults` | `"error"` | which game console output ends an episode as a fault: `"error"`, `"warn"`, `"off"` |
| `step_timeout` | 30 s | a worker that takes longer is killed and replaced |
| `spin_wait` | 0.002 s | busy-wait for replies before sleeping; 0 never busy-waits |
| `shared_code` | False | one compiled game per worker instead of per environment: cheaper resets, slower steps |
| `max_reset_retries` | 8 | new seeds to try when a scenario does not fit the drawn floor |
| `max_worker_restarts` | 3 | consecutive failures of one worker before the env raises |

`env.describe()` returns everything a run should record about itself (R16): harness, game commit and whether it
is pinned, profile, math layer, frame-skip, Node version, observation id, version and layout hash, task name and
version, seeds.

## Observation

A dict of fixed-shape NumPy arrays, batched over environments, holding only what a player can see on screen
(the one exception, `items`, is explained below). Full description: `docs/observation-spec.md`.

| Key | Shape per env | Content |
|---|---|---|
| `player` | 29 | position, velocity, facing, blinking, the HUD bar values (hearts, counters, stats, active item) |
| `hud` | 11 | floor, clock, boss bar, how many enemies, shots, pickups and items there are |
| `enemies`, `enemy_mask` | 32 × 15, 32 | visible enemies, nearest first |
| `shots`, `shot_mask` | 96 × 8, 96 | projectiles of both sides and bombs, nearest first |
| `pickups`, `pickup_mask` | 16 × 9, 16 | things on the floor, nearest first |
| `tiles`, `tile_prop`, `tile_damaged` | 9 × 15 each | the room's tile grid as drawn |
| `doors` | 4 × 5 | per side: present, kind, locked, closed, crack (of a hidden door) |
| `minimap` | 5 × 7 × 8 | the minimap window around the current room |
| `items`, `item_mask` | 64, 64 | passive items held, in pickup order |

- Column names: `env.obs_columns["enemies"]` etc. Vocabularies (what a `type` index means):
  `env.obs_vocab["sprites"]`, `["passive_items"]`, and so on; index 0 means none, so `vocab[k - 1]`.
- Units: room pixels (960 × 576), pixels per second, half hearts. Nothing is normalised.
- `items` is not on the screen of the current frame; every item was named on screen by its pickup banner. Drop
  it for a strict "this frame only" model.
- The observation of an environment whose episode ended in a fault is all zeros.
- `obs="none"` gives `{"none": zeros}` and switches the review gate off.

## Recording and watching episodes

Create the environment with `record=True`. A transcript holds the scenario, every key event with its frame,
the final state hash and how the run was produced (game commit, profile, math layer).

```python
from bota_harness import BotaVecEnv, ScenarioTask, load_scenario
import numpy as np

env = BotaVecEnv(16, ScenarioTask(load_scenario("single_bug")), record=True)
env.reset(seed=0)
while True:
    obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
    if "_result" in info:
        for i in np.flatnonzero(info["_result"]):
            env.save_transcript(i, "recordings/")      # a folder: the file is named for you
        break
```

- Call `save_transcript(i, path)` (or `transcript(i)` for the dict) **in the step that ended the episode**. With
  the default autoreset the next step starts a new episode, and its recording replaces the old one.
- `path` is a file name, or a folder (existing, or written with a trailing slash). In a folder the file is named
  `<kind>-<seed>-<reason>-<YYYYmmdd-HHMMSS>.json`, numbered if taken. Missing folders are created.
- Module functions: `save_transcript(transcript, path)`, `load_transcript(path)`. `BotaEnv` has
  `save_transcript(path)`.
- Episodes in which privileged control calls changed the game are marked `tampered`; they do not replay.

### Checking a recording

```
uv run bota-harness replay recordings/*.json
```

Replays each file in Node and prints whether it ends in the recorded state. From Python:
`bota_harness.replay.verify(path_or_dict)`.

### Watching it in the browser

```
uv run bota-harness view recordings/            # or: npm run view -- recordings/
```

Starts a local web server and prints its address (`http://127.0.0.1:8765/`, or the next free port). Open it in a
browser. The page loads the pinned game unmodified and replays the recording frame by frame with the game's own
renderer, with the same math, visual randomness and clock as the headless run, so you see what the agent's
episode looked like. When playback reaches the end, the page checks the game state against the recording and
shows "✓ ended in the recorded state" or "✗ differs from the recording".

- Recordings: from the files and folders given (folders are re-read while the server runs, so new recordings
  appear in the list), or open or drop a file in the page.
- Controls: play/pause, speed 0.25× to 32×, seek bar, one frame or one decision forwards or backwards, and a row
  of keys showing what the recording is pressing. "Recording details" shows scenario, result and setup.
- Keyboard: Space play/pause · ← → one frame · Shift+← → one decision · Home / End · `[` `]` speed.
- Links: `#t=<id>` opens recording `<id>` of the server's list.
- Options: `--port N` (first port to try; 0 picks any free one), `--open` (open the default browser).
- The server listens on 127.0.0.1 only and serves nothing but the game's scripts, the harness core, the page and
  the listed recordings.

HTTP endpoints, for scripting:

| Endpoint | Returns |
|---|---|
| `GET /` | the page (`?math=native` for recordings made with `det_math=False`; the page switches by itself) |
| `GET /api/info` | game and harness version, and the recordings: `id`, `name`, `path`, `seed`, `kind`, `reason`, `frames`, `playFrames`, `decisions`, `tampered` |
| `GET /api/transcripts/<id>` | one recording as JSON |
| `GET /game/<path>` | the game's scripts as its `index.html` lists them (not `main.js`) |
| `GET /harness/<file>` | `detmath.js`, `sim.js`, `scenario.js`, `recorder.js` |
| `GET /viewer/<file>` | `boot.js`, `viewer.js`, `viewer.css` |

## Faults

An episode never takes the training run down with it:

- **Game error** (an exception, or an error the game logs to its console): the episode ends as truncated with
  reason `fault`, and the game instance is rebuilt at the next reset.
- **Worker crash or hang** (no reply within `step_timeout`): the worker is killed and replaced; its environments
  end their episodes as `fault` and continue. A worker that fails `max_worker_restarts` times in a row stops the
  run with `WorkerFailure`.
- **Unreviewed content**: reason `unreviewed`; reported through the same channel with fault kind `unreviewed`,
  without rebuilding anything.

Each fault is in `info["fault"][i]` (kind, message, frame, game state, seed, scenario, worker output for crashes),
in `env.fault_log`, counted in `env.fault_count` and `env.worker_restarts`, and logged to the `logging` logger
`bota_harness` with seed and frame. A fault record plus the seed is enough to reproduce the episode.

Exceptions the API raises, all subclasses of `HarnessError`: `ScenarioError` (invalid scenario, or content without
a reviewed view), `ResetError` (a scenario with a fixed seed that does not fit), `WorkerStartError`,
`WorkerRequestError`, `WorkerFailure` (`WorkerCrashed`, `WorkerTimeout`).

## Privileged access

For debugging, tests and curriculum setup; never through the action space. All take an environment index.

| Call | Effect |
|---|---|
| `env.snapshot(i)` | detailed raw state as a dict |
| `env.signature(i)` | hash of the gameplay state (what transcripts end with) |
| `env.call(i, "god", True)` | god mode on or off |
| `env.call(i, "giveItem", "cold_brew")` | give an item |
| `env.call(i, "resources", 10)` | set credits, pushes and approvals to 10 (the default) and refill health |
| `env.call(i, "spawn", "bug", x, y)` / `"spawnBoss"` | spawn into the current room (not a real fight; prefer `TestRoom`) |
| `env.call(i, "gotoRoom", "treasure")`, `"nextFloor"`, `"killAll"` | move around, clear the room |

Calls that change the game mark the episode as `tampered`, and events they cause are not counted.

## Baselines and evaluation

The agent side lives in `src/bota_agent`. For now it holds the policy interface, three baseline policies and an
evaluation runner; learned policies come later and use the same interface.

### Policy interface

```python
state = policy.initial_state(n_envs)
state = policy.reset(state, mask, episode_keys)    # start of episodes: all after env.reset, info["reset"] after a step
actions, state = policy.act(obs, state)            # obs: dict of (n_envs, ...) arrays → int array (n_envs, 4)
```

`state` is per environment (a recurrent network's hidden state, a baseline's random generator). `episode_keys`
identify the new episodes; the evaluation passes the scenario seed, and policies that sample seed their
randomness from it, so an episode plays out the same in any environment slot, batch or worker layout.

| Policy | `make_policy` spec | Behaviour |
|---|---|---|
| `NullPolicy()` | `null` | always `[0, 0, 0, 0]` |
| `UniformRandomPolicy(seed)` | `uniform` | every head uniformly at random at every decision (jitters in place; presses Force Push at half of all decisions) |
| `StickyRandomPolicy(hold, seed)` | `sticky`, `sticky:<hold>` | a new uniformly random input every `hold` decisions (default 8 ≈ 0.5 s); movement and shooting held, Force Push and active item tapped once per period |

### Evaluation suites

`evals/<name>.json` names a scenario and a fixed list of seeds that every policy plays once (R18):

```json
{"description": "...", "scenario": "single_bug", "seed_prefix": "EVAL-SB-", "episodes": 1000, "success": ["room_clear"]}
```

gives the seeds `EVAL-SB-0000` … `EVAL-SB-0999` (or list them under `"seeds"`). `scenario` is a name from
`scenarios/` or an inline scenario without a seed. Training draws seeds of A–Z and 0–9 only, so a seed with `-`
never turns up in training. `success` lists the end reasons that count as success.

### Running an evaluation

```
uv run bota-agent suites                                             # list suites
uv run bota-agent eval                                               # all three baselines on single_bug
uv run bota-agent eval --policy sticky:4 sticky:16 --episodes 200    # other policies, first 200 seeds
```

Prints a table per policy: success, death and time-limit rates with 95 % confidence intervals (Wilson), median
seconds to success, damage per episode. Results go to `runs/eval/<suite>/<time>/<policy>/` (git-ignored):
`summary.json` (policy, suite, summary and `describe()` of the run), `episodes.jsonl` (one line per seed, for
seed-by-seed comparisons) and `recordings/` (the first `--record` seeds, default 5; watch them with
`uv run bota-harness view runs/eval/.../recordings/`). Options: `--envs`, `--workers`, `--frame-skip`, `--seed`
(the policies' own randomness), `--json`.

From Python:

```python
from bota_agent import StickyRandomPolicy, evaluate, load_suite, write_run
run = evaluate(StickyRandomPolicy(hold=8), load_suite("single_bug", episodes=200), num_envs=32)
print(run.summary["success"])          # {"count": ..., "rate": ..., "ci95": [lo, hi]}
write_run(run, "runs/my_eval")
```

The same policy on the same suite gives the same results with any number of environments and workers (tested).

## Command line

```
uv run bota-harness info [--game-dir DIR] [--profile lean|full] [--allow-unpinned]
uv run bota-harness bench [--scenario bug_room|full_run|<name>|<file>] [--envs N] [--workers N] [--secs S]
                          [--obs v2|none] [--frame-skip N] [--probe] [--shared-code] [--json]
uv run bota-harness replay FILE [FILE ...]
uv run bota-harness view [FILE|FOLDER ...] [--port 8765] [--open]
uv run bota-agent suites
uv run bota-agent eval [--suite NAME] [--policy SPEC ...] [--episodes N] [--envs N] [--record N] [--out DIR] [--json]
```

- `info`: verifies the checkout and prints `describe()`.
- `bench`: random policy for `--secs` seconds after a warm-up; prints decisions and frames per second, time
  per vector step, worker load, reset cost, episode ends, faults and memory.
- `replay`: replays recordings in Node; exit code 0 only if all match.
- `view`: the replay viewer.

## Using it from Node

The JS core runs without Python, one environment per object:

```js
const { createEnv } = require('./js/node/index.js');
const env = createEnv({ record: true });                     // options as in BotaVecEnv, camelCase
let ep = env.reset({ kind: 'test_room', seed: 'ABC', enemies: ['bug'], maxPlayFrames: 3600 });
while (!ep.done) ep = env.step(1, 4, 0, 0);                 // move, shoot, push, active: as in the action table
env.observation();                                           // { field: typed array }
env.transcript();                                            // the recording
```

`Recorder.replay(instance, transcript)` and `Recorder.Replayer` (frame by frame) replay recordings;
`node js/node/replay.js FILE` and `node js/node/viewer.js [paths]` are the scripts behind `replay` and `view`.
`node js/node/schema.js` prints the observation layout.

## Checks and benchmarks

| Command | What it checks |
|---|---|
| `npm test` | JS suite: scenarios, input, flow, events, observation fairness, recorder, viewer server |
| `uv run pytest` | Python suite: vector env contract, autoreset, faults, observation transport, scenarios, transcripts |
| `npm run check:determinism` | same seed and inputs give the same run, in many variations (about 3 min) |
| `npm run check:browser` | headless runs match the game in Chromium, including recorded episodes |
| `npm run check:viewer` | the replay viewer in Chromium: playback, seeking, end-state check |
| `npm run check:test-room` | constructed test rooms behave like real rooms |
| `npm run bench:heavy`, `bench:instances`, `bench:bridge` | Phase 0 throughput and memory measurements |

The browser checks use Playwright from the game checkout (its `tools/setup-dev.sh` installs it) and print
`SKIPPED` without it. Benchmark output goes to `bench/results/` (not tracked).

## Environment variables

| Variable | Effect |
|---|---|
| `BOTA_GAME_DIR` | game checkout (default `../BindingOfTheAgent`) |
| `BOTA_ALLOW_UNPINNED=1` | accept a checkout that is not `v1.0` |
| `BOTA_DETMATH=0` | Node only: native math instead of the deterministic layer |
| `BOTA_NODE` | Node executable (default `node` on `PATH`) |
| `BOTA_HARNESS_JS` | folder with the harness's `core/` and `node/` (default: the repo's `js/`, or the copy in the wheel) |
| `BOTA_SCENARIOS` | folder of named scenarios (default: the repo's `scenarios/`, or the copy in the wheel) |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "game checkout is not the pinned version" | `git -C ../BindingOfTheAgent checkout v1.0` and discard local changes there, or set `BOTA_ALLOW_UNPINNED=1` knowing results are not comparable. |
| `ScenarioError: ... no reviewed view for: enemy:...` | The scenario sets up content the observation does not cover yet. Use reviewed enemies, or `obs="none"` if nothing is fed to a model. |
| Full runs end as `unreviewed` almost at once | Expected for now: floor 1 has enemies without reviewed views. |
| A recording does not replay (`ok: false`, or "✗ differs" in the viewer) | It is `tampered` (control calls), was made on another game commit, or was saved after the next step had already reset the environment. |
| Low throughput on a laptop | Power management keeps lightly loaded cores slow; try fewer workers than cores (see `docs/phase2-results.md`). |
| `WorkerStartError: Node executable 'node' not found` | Install Node 22+, or set `BOTA_NODE`. |
