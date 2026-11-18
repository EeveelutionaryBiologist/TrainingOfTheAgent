# Training of the Agent — Requirements

Last edited: 2026-11-18. 

This document records what we want to build, the constraints, and what is still open.
It covers requirements and the choice of approach, not the detailed design.

---

## 1. Purpose

Train a reinforcement learning agent that plays *The Binding of the Agent* (sibling repo `https://github.com/EeveelutionaryBiologist/BindingOfTheAgent`).
This is an experiment: failing to get far is an acceptable outcome, as long as we learn why.

## 2. Goals

Goals are a ladder. Each one is only attempted once the previous one is met.

| Goal | Definition | What it proves |
|---|---|---|
| **Goal 0** | Survive one test room against one enemy. | The whole pipeline works end to end: wrapper, observation, reward, training. |
| **Goal 1** | Beat floor 1 once (kill the floor boss and take the trapdoor). | The agent can navigate between rooms, fight mixed enemies and beat a boss. |
| Later | Open. Candidates: reliable floor-1 win rate, deeper floors, the floor-11 boss. | To be set after Goal 1. |

Open detail for Goal 0 (see §9): which enemy, and whether "survive" means outlasting a time limit or clearing the room.

### Non-goals (for now)

- Learning from pixels (for now - interesting for a different reason but introduces an artificial handicap).
- Human demonstrations (shelved; a fallback if progress stalls)
- Search-based methods that need game snapshots.
- Playing in a real browser at real-time speed. A replay viewer for watching the agent is desirable but separate.

## 3. Fixed constraints

### 3.1 Hardware

Training runs on the following hardware as of writing this document:

- CPU: Ryzen 9 7950X3D (16 cores)
- RAM: 96 GB
- GPU: one RTX 4090 (24 GB VRAM)

Every approach must fit this budget. There is no cluster and no second GPU.

### 3.2 Game version

- The game is pinned at release tag **`v1.0`** (commit `cc5cba4`).
- We own the game repo, so forking or editing it is allowed. The default is still to wrap it from outside and
  leave it untouched; an edit needs a stated reason (§9 lists the one candidate).
- Any change of the pinned version invalidates earlier results and must be recorded with them.

### 3.3 Fair observation (hard rule)

**The model must never receive state information that a human player could not see on screen at that moment.**

This is enforced as an allowlist: a field enters the observation only if we can name where and how it appears on screen.
Fields are never taken from the game state by default and then filtered.

Known cases that need care:

| Entity | What the game state holds | What the model may see |
|---|---|---|
| Hallucination | an enemy | a pickup of its disguise type, until it is revealed |
| Trojan | an enemy | a prop of its disguise kind, until it is revealed |
| Secret rooms | hidden door edges and room cells | the crack the game draws on the wall over a hidden door; nothing else until the door has been blown open |
| Floor map | every room of the floor | only what the minimap shows (seen and visited rooms; more after README.md or a map item) |
| Enemy health | exact values | only when the Code Review item draws health bars; the boss bar is always visible |
| Graphics Glitch | intact HUD values | the scrambled HUD area is masked on exactly the frames it is scrambled (including the flicker as it ends) |
| Enemy internals | timers, scratch state, planned attacks | only the telegraphs that are drawn |
| Pedestals and Terms of Service | item id, contract clause | what is drawn; the contract only once it is readable on screen |
| RNG state, seed, planned contents of other rooms | all present in memory | never |
| Inventory | passive items held, their effects | the list of items held, since each one was named on screen by its pickup banner; offered to the trainer, not required |

Consequences:

- Each enemy and boss needs a short review of what it visibly signals before it may appear in training.
  Goal 0 needs this for one enemy; Goal 1 for the floor-1 roster and bosses.
- The allowlist and these reviews are kept in the repo as a written spec, with a test per special case above.
- The reward function and the curriculum may use hidden state (they are not model inputs). The observation and
  anything else fed to the network may not.

## 4. Facts about the game that shape the design

As taken from the `v1.0` source.

- **Engine:** vanilla JavaScript, fixed 60 Hz step. `game.update(DT)` is separate from rendering.
- **Headless speed:** the simulation runs unmodified in plain Node at about 93,000 steps/s on one core
  (about 1,550× real time). Measured with a random policy on floor 1; busy rooms will be slower.
- **Input:** `BOTA.input._simulate(code, down)` exists for tests. Actions are move (8 directions or none),
  shoot (4 directions or none), Force Push (bomb, one button) and use active item (one button).
- **State:** 15 × 9 tile grid per room, lists of enemies, projectiles and pickups,
  player stats and items, the floor map.
- **Scenario control:** `BOTA.debug.*` can spawn any enemy or boss, give any item, jump to a room type or floor,
  and switch god mode. This is the basis for test rooms and a curriculum.
- **Seeds:** gameplay randomness goes through a seeded generator. Item rolls depend on the order rooms are visited.
- **Singletons:** `BOTA.game` and `BOTA.input` are global, so one game instance per JavaScript context.
- **No snapshot or restore:** state lives in class instances and closures.
- **Scale of a full run:** 11 floors, up to 20 rooms per floor, 36 enemies, 13 bosses, 55 items.

## 5. Chosen approach

Decision: **model-free RL on structured state**, with a curriculum built from the debug hooks.

| Approach | Verdict | Reason |
|---|---|---|
| A. Model-free (PPO-style) on structured state | **Chosen** | Small network, simulation is nearly free, simple and robust. |
| D. Hierarchy: navigator over the room graph + learned combat policy | **Likely for Goal 1** | Splits the problem where it naturally splits. Decide after Goal 0. |
| F. Human demos + RL | Shelved | Fallback if exploration stalls. Depends on deterministic replay. |
| B. Pixels | Rejected for now | Needs a renderer, 10–100× slower, spends the GPU on learning to see. |
| C. World model (Dreamer-style) | Rejected for now | Its strength is sample efficiency, which is not our bottleneck. |
| E. Search (MCTS, Go-Explore) | Blocked | Needs snapshot and restore. |

The network architecture, the algorithm's exact variant and the hyperparameters are design questions, not requirements,
and are left to the design phase.

## 6. Functional requirements

### 6.1 Environment wrapper

The environment wrapper should be developed in Python and be as purpose-agnostic as possible. It serves as a direct interface for reading the game-state for every frame as well as sending frame-exact input to the engine *and* wraps the Debug Mode (for experimental scenario setup).

Potentially, the environmental harness should be moved to it's own repository

- R1. Loads the game from the pinned version without a browser and steps it under program control.
- R2. Exposes reset, step and close in a standard RL interface usable from Python.
- R3. Reset accepts a scenario: full run from a seed, or a constructed test room (enemy types and counts, layout,
  player items and health).
- R4. Supports frame-skip: one agent decision is held for N simulation steps. N is configurable; the starting value is 4 (15 decisions/s).
- R5. Handles non-play states (title, floor card, transitions, boss intro, pause, death, score card) itself, so the
  agent only ever acts in play.
- R6. A game exception ends the episode and is logged with seed and step; it must not kill the training run.
- (R7)). -> Later: Should provide functionality for writing a transcript to allow a later replay.

### 6.2 Observation

- R7. Built only from the allowlist of §3.3.
- R8. Structured, not pixels: the room's tile grid, a variable-length list of visible entities with type and
  kinematics, the player's own visible status (health, resources, items, active-item charge), and the minimap as shown.
- R9. Versioned. A change to the observation gets a new version number, stored with every checkpoint.

### 6.3 Actions

- R10. The action space matches the keyboard and nothing more: move, shoot, Force Push, active item.
- R11. No debug or cheat function is reachable through the action space.

### 6.4 Reward

- R12. The reward is defined per goal and versioned like the observation.
- R13. Shaped rewards are allowed, but success is always judged by the goal's own criterion (§6.6), never by reward.

### 6.5 Training

- R14. Runs many environment instances in parallel across the 16 cores, with the policy on the GPU.
- R15. Checkpoints regularly and can resume after an interruption.
- R16. Every run records: game version, observation and reward versions, configuration, random seeds.
- R17. Logs learning curves and the goal metrics during training.

### 6.6 Evaluation

- R18. Uses a fixed set of seeds or scenarios that are never used for training.
- R19. Goal 0 metric: survival or clear rate in the test room over a fixed number of episodes.
- R20. Goal 1 metric: share of evaluation runs that finish floor 1.
- R21. Always reported next to two baselines: a random policy and a do-nothing policy.

### 6.7 Watching the agent

- R22. A recorded episode (seed plus the agent's inputs) can be replayed in the real game in a browser.
  This depends on the determinism check in §8.

## 7. Non-functional requirements

- N1. **Throughput:** not fixed yet. To be set after measuring the bridge and inference; the simulation itself
  allows several hundred thousand steps/s across 16 cores.
- N2. **Memory:** all environment instances plus training buffers stay well inside 96 GB RAM and 24 GB VRAM.
- N3. **Reproducibility:** the same configuration and seeds give the same evaluation result, within the limits of GPU nondeterminism.
- N4. **Isolation:** one crashing environment does not affect the others.
- N5. **Upstream hygiene:** this repo contains no copy of the game source; it references the pinned version.

## 8. Checks to run before building

| Check | Why it matters |
|---|---|
| Determinism headless: same seed and inputs give the same run, twice in Node and once against a browser | Needed for R22, for reproducible evaluation, and for demos if we ever want them. |
| Step rate in the heaviest rooms (bosses, 200 projectiles) | Sizes the parallelism and N1. |
| Memory per game instance, and instances per process | Sizes N2 and the process layout. |
| Cost of the Node-to-Python bridge per step | Likely the real throughput limit. |
| A constructed test room behaves like a real room (doors, clearing, spawn delay) | Goal 0 must not train on an artefact of the debug hooks. |

## 9. Open questions

1. **Goal 0 details:** which enemy, and is success "alive after T seconds" or "room cleared"? Suggestion: start
   with the Bug (basic chaser), success means the room is cleared without dying.
2. **Frame-skip:** is 15 decisions/s fast enough for the tightest dodges? To be tested, not assumed.
3. **Navigation for Goal 1:** scripted navigator, learned navigator, or one flat policy? Decide after Goal 0.
4. **Items in Goal 1:** floor 1 has a treasure room. Does the agent learn item pickup from the start, or is that deferred?
5. **Game edits:** the one candidate is snapshot and restore, which would unblock approach E. Not needed for Goals 0 and 1.
6. **Training stack:** language and libraries on the Python side. A design decision, listed so it is not forgotten.

## 10. Decision log

| Date | Decision |
|---|---|
| 2026-11-11 | Training hardware fixed: 7950X3D, 96 GB RAM, one RTX 4090. |
| 2026-11-11 | Game pinned at `v1.0`. Edits to the game allowed, wrap-only by default. |
| 2026-11-11 | Structured-state observation first. Fair-observation rule is a hard requirement. |
| 2026-11-11 | Goal 0 and Goal 1 defined as in §2. |
| 2026-11-11 | Human demonstrations shelved. |
| 2026-11-18 | Observation review: the secret-door crack is observed; the passive item list is exposed (optional for the model); the glitch mask follows the screen frame by frame; list caps stay. Observation version 2. |
