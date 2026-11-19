# BotA Environment Harness — Technical Plan (draft 1)

## Context

`REQUIREMENTS.md` asks for an RL agent that plays *The Binding of the Agent* (game repo at `../BindingOfTheAgent`,
pinned at `v1.0`, commit `cc5cba4`). This repo is only the **environment harness**: a Python-facing wrapper that
loads the game without a browser, steps it frame-exactly, feeds keyboard input, sets up scenarios, and exposes a
fair observation. Training, goal rewards and evaluation live in a separate training repo.

Decisions taken with the user (2026-11-12):

| Topic | Decision |
|---|---|
| Repo scope | Wrapper (R1–R6), fair observation (§6.2), actions (§6.3), input recording. A pluggable **Task interface** (reward, success, end conditions) with one trivial reference task for tests. No goal rewards, training or evaluation here. |
| Game source | Local checkout, verified. Path from config or `BOTA_GAME_DIR` (default `../BindingOfTheAgent`). Loader refuses to start unless HEAD is `cc5cba4` and the tree is clean; an explicit override flag exists and is recorded. |
| After approval | Save this plan in the repo, run Phase 0 (the §8 checks), report numbers, stop. |

## What the source and a quick probe showed

Probe: floor 1, random policy, one core, in-memory only. Numbers are indicative, Phase 0 re-measures them properly.

- The game loads unmodified in plain Node with a few DOM stubs (`window`, `document.getElementById/createElement`
  returning a canvas stub, `localStorage`, `location`, `performance`, `requestAnimationFrame`). `main.js` is the only
  file we do not load; its six lines of bootstrap are replaced by ours (no rAF loop).
- **Determinism held**: same seed and inputs gave an identical end state across fresh instances, across both loading
  methods, and with or without `audio.js` / `effects.js` / `render/*`.
- **Loading method decides speed.** One `vm` context per instance: about 45–57k steps/s. All scripts compiled once
  into a single factory function (`vm.compileFunction`, with `window`, `document`, … as parameters): about
  120–175k steps/s, and each call yields an independent instance in the same realm.
- Fresh instance: about 15 ms. In-instance reset (`new B.Game()` + `newRun`): about 1.4 ms. Heap per instance: well
  under 1 MB.
- Many instances in one process were slow in a short test (about 48k steps/s for 64), but that run was dominated by
  JIT warm-up per instance. Steady state is unknown and is a Phase 0 measurement.
- Engine facts that drive the design:
  - `main.js` swallows exceptions from `game.update`; item hooks and bus listeners swallow theirs via
    `console.error`. The harness must surface both (R6).
  - Bomb and active item are edge-triggered (`input.pressed`), movement and shooting are level-triggered.
  - `BOTA.debug.spawn` into the start room is not a real fight: the room is already `cleared`, so doors never close
    and `onRoomClear` never fires. Real behaviour comes from `enterRoom` → `populate` → `closeDoors`.
  - `Math.random` is used for visuals only (effects, shake, ambience); `performance.now` only for visuals.
  - `newRun` does not reset every field of `Game` (e.g. `pendingBossIntro`, `pipeCooldown`), and
    `enemies-deep.js` keeps module-level state that resets on `runStart`.

## Architecture

```
Python (training repo)                    Python (this repo)                       Node worker process (this repo)
  policy, Task (reward) ── Gymnasium ──▶  BotaVecEnv ── binary frames, stdio ──▶  K game instances
                                          WorkerPool (W processes)                  loader · input · flow · scenario
                                                                                    observer (fair) · probe (privileged)
                                                                                    recorder
```

Three layers. The JS core has no Node dependencies, so the same code can later be injected into a browser page for
the determinism check and the replay viewer (R22).

### 1. Game loading (`js/node/loader.js`)
- Verify the checkout (commit, clean tree), read the script order from the game's `index.html`, skip `main.js`.
- Compile all files once into one factory function; each call creates an instance with its own stub host objects.
- Global `Math.random` is replaced by a dispatcher that points at the current instance's seeded stream, so visual
  randomness is reproducible too. `performance.now` is tied to the instance's simulation clock.
- Two load profiles: `full` (everything but `main.js`, the default) and `lean` (also without `audio.js` and
  `effects.js`, about 20 % faster in the probe). `lean` becomes the default only if Phase 0 shows identical
  trajectories over a large seed set.

### 2. Instance lifecycle (`js/core/instance.js`)
- Reset is in-instance: clear input, `B.game = new B.Game()`, reseed the visual stream, then build the scenario.
- After any fault the instance is discarded and rebuilt from the factory.
- A Phase 0 test proves that in-instance reset equals a fresh instance for the same seed and inputs.

### 3. Stepping, input and non-play states (`input.js`, `flow.js`)
- One simulation frame is `game.update(DT); B.input.endStep()`, exactly as `main.js` does it.
- Input goes through `B.input._simulate` only. The driver holds a key set and emits key-down/up differences.
  Force Push (`KeyE`) and active item (`Space`) are pressed on the first frame of a decision and released on the next.
- Action space (R10): `MultiDiscrete([9, 5, 2, 2])` = move (none + 8), shoot (none + 4), Force Push, active item.
  Only `KeyW/A/S/D`, the four arrows, `KeyE` and `Space` can be emitted, so pause, restart, mute, `F2` and the debug
  keys are unreachable (R11). A test fuzzes the action space and asserts that.
- Frame-skip (R4): one decision spans N **play** frames, default 4, configurable per env.
- Non-play states (R5): the flow controller advances title, floor card, room and floor transitions and boss intro
  inside the same `step` call, with no extra key presses (they time out on their own; simulation time is cheap).
  The agent only ever sees `play` or a terminal state. `dead` and the score card are terminal.
- A raw per-frame key API stays available below the RL interface for purpose-agnostic use (replays, scripted tests).

### 4. Scenarios (R3) (`scenario.js`, Python `Scenario` dataclasses)
- `FullRun(seed, start_depth=1)`: `newRun(seed)`, optionally `enterFloor(depth)`.
- `TestRoom(seed, depth, layout, enemies, player, end_on, max_frames)`:
  - generate the real floor from the seed, take an unvisited room next to the start room,
  - set its layout (`stampLayout` with a game layout id or custom 13×7 rows), `plannedEnemies`, and clear loot, pipe,
    props and README,
  - apply player setup (items via `giveItem`, health, resources),
  - enter through the door with `changeRoom(dir)`, so `populate`, door closing, spawn delay and the clear event all
    run through the game's own path.
- End conditions are declarative and checked every frame in JS: `death` (always), `room_clear`, `floor_exit`,
  `max_frames` (truncation).
- `BOTA.debug.*` is wrapped for experiments (`god`, `giveItem`, `resources`, `spawn`, `spawnBoss`, `gotoRoom`,
  `nextFloor`, `killAll`) but is reachable only through scenario and control calls, never through actions.

### 5. Fair observation (§3.3, R7–R9) (`js/core/observe/`, `docs/observation-spec.md`)
- The fairness boundary sits in JS, where the state is. The observer is an **allowlist**: each field is written by
  an explicit extractor, and each has an entry in the spec naming where it appears on screen.
- **Review gate:** every enemy, boss, pickup and prop type needs a registered "view" (what it visibly shows,
  including telegraphs). If an entity without a view exists in the room, reset fails or the episode ends as a fault.
  This enforces "reviewed before it may appear in training" mechanically.
- Rules that prevent leaks:
  - Entities are listed as displayed: a disguised Hallucination is a pickup, a disguised Trojan is a prop tile.
  - The list is sorted by a screen-derived key, so list position cannot reveal which internal array an entity is in.
  - Kinematics are finite differences of displayed positions, not the engine's internal `vx/vy`.
  - Minimap, enemy health, HUD glitch and secret doors follow the table in §3.3; where the renderer exposes its own
    visibility logic (e.g. `HUD.scanMarks`), the observer calls that instead of re-implementing it.
- Observation v1 covers Goal 0: 15×9 tile grid with door states, player status as shown in the HUD, padded entity
  list with mask, 7×5 minimap window, boss bar, glitch mask. Goal 1 adds views for the floor-1 roster and bosses.
- The layout of the observation is defined once in a schema file read by both JS and Python, and carries a version
  number (R9) that every reset reports.
- One test per special case in the §3.3 table.

### 6. Privileged channel and Task interface (R12, R13)
- Separate from the observation and never part of the observation space:
  - per-decision **event counters** collected from `B.bus` (damage taken, damage dealt, kills, rooms cleared,
    pickups, items, floor exits) in a fixed-size vector,
  - an opt-in **raw state probe** for curriculum, debugging and tests.
- Python `Task` protocol: `scenario()`, `reward(events, probe) -> float`, `success(episode) -> bool`, `version`.
  The env takes a Task; without one the reward is 0. This repo ships a trivial reference task only.

### 7. Bridge and process layout (R14, N1, N4)
- `W` Node worker processes, each hosting `K` instances (both configurable; `K = 1` is valid).
- Length-prefixed binary frames over the worker's stdin/stdout. One request steps all `K` envs for a full decision
  and returns one packed buffer: observations, event counters, flags. JSON is used only for control messages
  (init, reset scenario, fault reports).
- Synchronous vector step first (send to all workers, wait for all). An asynchronous mode is added only if Phase 0
  or training shows the need.
- Alternative considered: V8 embedded in Python (PyMiniRacer). Rejected for now: it still needs worker processes
  for parallelism and isolation, and the Node worker is the same code path the browser replay will use.

### 8. Python API (R2) (`bota_harness`)
- `BotaVecEnv` implements the Gymnasium vector API; `BotaEnv` is the single-env convenience over it.
- `reset(seed=..., options={"scenario": ...})`, `step(actions)`, `close()`. Autoreset follows the installed
  Gymnasium version's convention (to be checked against that version when implementing).
- Observation space: `Dict` of fixed-shape arrays with masks. Encoding for a network is the trainer's concern.
- `info` carries seed, frame counters, fault reports and the game/observation/harness versions (R16 inputs).

### 9. Faults and isolation (R6, N4)
- Per instance: exceptions from `game.update` and anything the game sends to `console.error` end the episode as
  truncated with a fault record (seed, scenario, frame, input log); the instance is rebuilt.
- Per worker: a crash or a response timeout (hang) makes Python kill and respawn the worker; its `K` envs report a
  fault and continue. Other workers are unaffected.

### 10. Recording (R7-later, R22)
- The recorder stores seed, scenario, versions and the per-frame key events. This is built in Phase 1 because the
  determinism tests need it anyway. The browser replay viewer is a later phase.

## Repo layout

```
REQUIREMENTS.md
docs/TECHNICAL_PLAN.md          this plan
docs/observation-spec.md        allowlist and per-entity reviews
docs/phase0-results.md
schema/obs_v1.json              observation layout, shared by JS and Python
scenarios/                      named scenarios as JSON files (scenarios/README.md), load_scenario(name)
js/core/                        instance, input, flow, scenario, observe/, probe, recorder (browser-compatible)
js/node/                        loader, worker, protocol
js/test/                        node:test suites
src/bota_harness/               game_source, protocol, worker_pool, vec_env, env, scenario, task, spaces, cli
tests/                          pytest suites
bench/                          Phase 0 and regression benchmarks
pyproject.toml  package.json    uv-managed Python 3.12; Node 22, no runtime npm dependencies
```

## Phases

| Phase | Content | Exit criterion |
|---|---|---|
| **0. Checks (§8)** | Loader, minimal instance, benchmarks. See below. | `docs/phase0-results.md` with numbers and a go/no-go on the bridge layout. |
| 1. JS core | Instance lifecycle, input driver, flow controller, scenarios, recorder, fault capture. | A scripted Bug test room runs to room clear and to death in Node; determinism suite green. |
| 2. Bridge + Python env | Worker protocol, `WorkerPool`, `BotaVecEnv`, Task interface, reference task. | Random policy runs across all cores from Python; crash and hang injection tests green. |
| 3. Fair observation v1 | Schema, observer, review gate, spec doc, special-case tests for Goal 0 content. | Observation spec reviewed; leak tests green. |
| 4. Goal 1 content + replay | Views for the floor-1 roster and bosses; browser replay of a recorded episode. | Full floor-1 runs pass the review gate; a recording replays identically in Chromium. |

### Phase 0 in detail (what runs after approval)
1. `git init`, save this plan as `docs/TECHNICAL_PLAN.md`. No commit unless asked.
2. Game-source verification and the factory loader.
3. Checks, each with a script under `bench/`:
   - **Determinism:** many seeds × random inputs, twice in Node; in-instance reset versus fresh instance; `full`
     versus `lean` profile; once against Chromium (Playwright, rAF neutralised, same stepping, state hash compared).
   - **Heavy rooms:** step rate with each boss and with 200 projectiles.
   - **Memory and instance count:** RSS per instance; steady-state throughput for `K` = 1, 4, 16, 64 per process.
   - **Bridge cost:** Python ↔ Node round trip with realistic payload sizes, per message and per env.
   - **Test-room realism:** a constructed room versus a real room: door closing, spawn delay, clear event, drops.
4. Write `docs/phase0-results.md`, propose `W`, `K` and the default load profile, then stop.

## Verification

- JS: `node --test js/test` (determinism, flow controller, input edges, scenario realism, review gate, leak cases).
- Python: `uv run pytest` (protocol round trip, vector env contract, autoreset, fault injection, action-space fuzz
  for R11).
- End to end: `uv run bota-harness bench --workers 16` with a random policy; `uv run bota-harness check` reruns the
  Phase 0 checks as a regression gate after any change to the loader or the pinned game version.

## Open points (not blocking Phase 0)

1. How wide the player-status part of the observation is: the HUD shows stats and the active item; the passive item
   list is only visible on the pause screen, which the agent cannot open (§3.3, inventory row).
2. Whether non-play frames should count toward a time limit.
3. Entity list cap and what happens above it (a room can hold 200 projectiles).
4. Playwright for the browser check: optional dev dependency of this repo, or reuse the copy in the game checkout.

## Changes after Phase 0 (2026-11-12)

Details and numbers: `docs/phase0-results.md`.

- **Math (new):** Node and Chromium disagree in the last bit of `sin`, `cos`, `exp`, `pow` and others, so native
  runs drift between engines. `js/core/detmath.js` (engine-independent replacements) makes them bit-identical at
  no measurable cost. **Default since 2026-11-13 (agreed for now).** Runs must record whether it was on.
- **§1 Game loading:** the game is compiled once per instance, not once per process. Sharing one compiled copy
  slowed multi-instance processes down by up to a third.
- **§1 Load profile:** `lean` passed the determinism check. **Default since 2026-11-13 (agreed for now).**
- **§2 Instance lifecycle:** exactly one key driver per instance; reset releases all keys through it.
- **§7 Bridge:** layout A (one pipe per worker process) is kept. A single hub process with worker threads was
  measured and was no faster. Throughput on the dev laptop is bridge-bound at about 45–57k decisions/s; `W`, `K`
  and N1 are to be settled on the training machine (deferred 2026-11-13).
- **§9 Faults:** the worker hang timeout is confirmed as necessary (a NaN in game state can loop forever).

## Phase 1 status (2026-11-13): built

Code: `js/core/scenario.js`, `js/core/env.js`, `js/core/recorder.js`, `js/node/index.js`; tests in `js/test/`
(`npm test`). The exit criterion is met: a scripted Bug test room runs to room clear and to death in Node.

What exists now:

- **`Env`** (`createEnv()` in `js/node/index.js`): `reset(scenario)` and `step(move, shoot, push, active)`.
  It applies frame-skip, steps through non-play states without key events, checks end conditions every frame,
  and turns game exceptions and `console.error` output into a fault record instead of throwing.
- **Scenarios**: `full_run` and `test_room`, as plain JSON (format in the header of `js/core/scenario.js`).
- **Recorder**: `Env.transcript()` and `Recorder.replay()`. Replay is a plain frame loop that does not use `Env`.
  Episodes recorded in Node replay to the identical state in Chromium (`bench/browser_determinism.js`).

Decisions taken while building:

| Topic | Decision |
|---|---|
| Time limit (open point 2) | Counts **play** frames only, since the agent cannot act in the others. Field `maxPlayFrames`. |
| Reset cost of a test room | The floor card is skipped: `changeRoom` is called right after setup, so the first decision is 17 frames in. A full run waits the 132-frame floor card. |
| Boss fights | `test_room` takes `boss: <id>` instead of enemies. The room becomes a boss room (intro, boss bar, trapdoor on clear). New end condition `boss_kill`. |
| Seeds without a usable room | `ScenarioError`, the caller picks another seed. On floor 1 this happened for 0 of 2,000 seeds. |
| After a fault | The instance is always discarded and rebuilt at the next reset. |
| Console output | `console.error` from the game is a fault by default (`consoleFaults`: `error`, `warn`, `off`). |
| Key state | Every reset releases all ten gameplay keys in the game's input module, whatever the driver believes is held. |
| Transcript | Format 1: scenario, frame-skip, start and end frame, raw key events (frame, key, down/up), result, final state hash, and the run description (game commit, profile, math layer, Node version). |

Left for later, as planned: event counters and the raw state probe (Phase 2), the observation (Phase 3). A scenario
that enters an untouched room of a given type (treasure, shop, the floor's real boss room) was considered and not
built; `test_room` with `boss` covers the boss case for now.

## Phase 2 status (2026-11-13): built

Code: `js/core/events.js`, `js/core/probe.js`, `js/core/control.js`, `js/node/worker.js`, `js/node/replay.js`,
the Python package `src/bota_harness/`, tests in `js/test/events.test.js` and `tests/`. Numbers and open
measurements: `docs/phase2-results.md`. The exit criterion is met: a random policy runs across all cores from
Python, and the crash and hang injection tests pass.

What exists now:

- **`BotaVecEnv`**: Gymnasium vector env over `W` worker processes with `K` envs each. `BotaEnv` is the
  single-env front. Gymnasium's `check_env` passes.
- **Worker protocol** (version 1, described in the header of `js/node/worker.js`): length-prefixed frames on the
  worker's stdin/stdout, a fixed binary record per env and step, JSON only when something happened.
- **Task interface** (`src/bota_harness/task.py`): `scenario()`, `reward()`, `success()`, name and version.
  `ReferenceTask` (two Bugs) is the test fixture.
- **Privileged channel**: 21 event counters per decision from the game's event bus; an optional probe of 26
  raw state values; control calls that wrap `BOTA.debug.*`. None of it is part of the observation.
- **Supervision**: a game error ends one episode; a dead or hung worker is killed and replaced, its envs report
  a truncated episode; everything is logged with seed and frame.
- **CLI**: `bota-harness info`, `bench`, `replay`.

Decisions taken while building:

| Topic | Decision |
|---|---|
| Observation before Phase 3 | A constant placeholder `{"none": zeros}`; `describe()["obs"]` is `{"id": "none", "version": 0}`. Gymnasium rejects an empty observation space. The reply format already has a slot for the observation block. |
| Task reward signature | `reward(step)` for all envs at once (arrays), not `reward(events, probe)` per env as drafted in §6. One Python call per vector step instead of one per env. |
| Autoreset | Gymnasium `NEXT_STEP` (default) and `DISABLED` with `reset(options={"reset_mask": ...})`. `SAME_STEP` is not built. |
| Who draws scenario seeds | Python, from one generator per env derived from the `reset(seed=...)` value. Episodes therefore do not depend on how envs are spread over workers (tested with 1, 3 and 6 workers). |
| A seed that does not fit the scenario | The worker reports it as retryable; the env draws another, up to `max_reset_retries` (8). An invalid scenario raises `ScenarioError` at once. A scenario with a fixed seed that does not fit raises `ResetError`. |
| Events during control calls | Not counted. Counters cover exactly the frames of a decision, so kills by `killAll` are not credited to the agent. A mutating control call marks the episode and its transcript as `tampered`. |
| Hang detection | Timeout per request (`step_timeout`, default 30 s), then SIGKILL and a fresh worker. A worker that fails more than `max_worker_restarts` (3) times in a row stops the run with an error. |
| Waiting for workers | Python busy-waits up to `spin_wait` (2 ms) before sleeping. Sleeping cost more than the simulation on the dev laptop. |
| Worker output | stdout carries only the protocol; `console.log` in the worker goes to stderr, which is kept and attached to crash reports. |
| Packaging | The wheel contains `js/core` and `js/node`; an editable install uses the repo's `js/`. `BOTA_GAME_DIR` names the game checkout when the default sibling folder does not apply. |

Left open:

- Throughput target, `W` and `K`: to be measured on the training machine (`docs/phase2-results.md`).
- Reset cost inside loaded workers (6 to 10 ms on the laptop) and whether a cheaper reset path is needed.
- Asynchronous stepping (not waiting for the slowest worker) was not built; no evidence yet that it is needed.

## Phase 3 status (2026-11-16): built, spec awaiting review

Code: `js/core/observe.js`, `js/node/schema.js`, `schema/obs_v1.json`; tests in `js/test/observe.test.js` (with
`render_probe.js`) and `tests/test_observation.py`. The spec to review is `docs/observation-spec.md`. Exit
criterion: leak tests are green; the spec review is the open half.

What exists now:

- **Observation v1** as the default of `Env`, the worker and `BotaVecEnv` (`obs="v1"`): player and HUD values,
  enemies, shots, pickups, tile grid with props, doors, minimap window, boss bar, glitch masks. 6,572 bytes per
  env, written straight into the worker's reply.
- **Review gate.** Reviewed so far: Bug, Null Pointer, Memory Leak, Leaklet, plain projectiles, bombs, all
  pickup types, trapdoor, pipe, props. Anything else ends the episode as `unreviewed` or is refused at reset.
- **`obs="none"`** keeps the Phase 2 placeholder and switches the gate off, for benchmarks and reward work.

Decisions taken while building:

| Topic | Decision |
|---|---|
| How fairness is tested | Against the game's own renderer: its draw code runs on a recording canvas, and the observation must list exactly what was drawn. Plus non-interference: hidden state is changed and the observation bytes must not move. |
| Entity type | The name of the sprite that is drawn. A disguise can then only be observed as the disguise. |
| Schema file (plan §5) | The layout is defined in `observe.js`, reported by the worker at start, and frozen as `schema/obs_v1.json`, which a test compares against. Python builds its spaces from the worker's report, so there is one definition. |
| Velocity | Displacement of the drawn position over the last frame, times 60. Needs one extra pass over the room before the last frame of a decision. |
| Entity list cap (open point 3) | Three lists with their own caps (32 enemies, 96 shots, 16 pickups), nearest to the player first, totals reported. |
| Player status (open point 1) | Only what the HUD bar shows. The passive item list is not observed. |
| Unreviewed content | Ends the episode with the new reason `unreviewed` (truncated). It uses the fault channel (`info["fault"]`, kind `unreviewed`) but does not rebuild the game instance. |
| After a game fault or worker failure | The observation of that env is all zeros. |
| Secret-door crack | Drawn by the game as a hint, left out because REQUIREMENTS §3.3 says "nothing". Open for review. |
| Wire format | Protocol 2: K observation blocks follow the K records; `unreviewed` appended to the reasons. |

Cost, measured in one hot Node process: about 3.6 µs per decision with eight environments (11.2 → 14.9 µs), 1 to
3 µs with one. Two things were needed to get there:

- no allocations in the per-decision path (first version: 12 µs with one environment);
- **a private compiled copy of the harness core per environment** (`js/node/core_loader.js`). Each game instance
  has its own compiled code and therefore its own object shapes; a shared observer could not be specialised by
  V8 and cost 13 µs per decision at eight environments per process. This is the same effect as the per-instance
  game code found in Phase 0. `shared_code=True` switches both back to shared copies.

Through the bridge on the dev laptop the observation costs more than that (64 envs on 8 workers: about 20,000
decisions/s with it, 21,000 to 32,000 without; the spread between identical runs is as large as the difference).
To be measured properly on the training machine together with the rest (`bota-harness bench --obs v1|none`).

Left open: the four review questions at the end of the spec; views for the rest of the floor-1 roster, bosses,
pedestals, Hallucination and Trojan (Phase 4).

## Observation review (2026-11-18): version 2

The user reviewed `docs/observation-spec.md`. Changes, all in `js/core/observe.js`; layout frozen as
`schema/obs_v2.json`, 6,708 bytes per env; `v2` is the default everywhere and `v1` is no longer produced.

| Question | Decision | Built |
|---|---|---|
| Secret-door crack | Observed: the game draws it for every hidden door, and a perfect player always spots it. REQUIREMENTS §3.3 changed accordingly. | `doors` gains a `crack` column. Test cross-checks it against the background bake. |
| Passive items | Exposed as a list; whether the model gets it is the trainer's choice. Justified by the pickup banner, which names every item when `giveItem` runs. | `items` (64, indices into `vocab.passive_items`, pickup order), `item_mask`, `hud.items_total`. An unknown id goes to the review gate. |
| List caps | Unchanged. | – |
| Glitch flicker | Follow the screen. | The masks reproduce `hud.js glitchFor`, including the flicker in the last second, on the instance's clock (`Env` passes `host.clockMs` to `write`). Without a clock: masked for the whole glitch, as before. Test compares with the HUD's drawing frame by frame. |

