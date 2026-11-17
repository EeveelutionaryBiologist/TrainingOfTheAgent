# Phase 0 results — the §8 checks

Date: 2026-11-12. Game `v1.0` (`cc5cba4`), Node 22.23.1 (V8 12.4), Chromium 156 (Playwright headless shell).

**Machine caveat.** Everything here was measured on the development laptop (Intel i5-1240P, 4 P-cores + 8
E-cores, 16 threads, 12 MB L3), not on the training machine (7950X3D). Correctness results carry over. Timing
results do not, in particular everything that depends on cache size. Rerun the benchmarks there before fixing N1.

## Summary

| §8 check | Result |
|---|---|
| Determinism, headless | **Pass.** Twice in Node, in-instance reset vs fresh instance, lean vs full profile, Node 18 vs Node 22. |
| Determinism, against a browser | **Fails with the engines' own math. Passes with `js/core/detmath.js` on both sides.** Adopted as the default, see §2. |
| Step rate in the heaviest rooms | Bosses 15k–105k frames/s per core. Dense artificial rooms 6k–11k. |
| Memory per instance, instances per process | About 114 MB per process, about 4–5 MB per extra instance. One instance per process is fastest. |
| Cost of the Node-to-Python bridge | 22–27 µs per round trip. It is the throughput limit: about 45–57k decisions/s here, against about 500k that the workers could simulate. |
| Constructed test room behaves like a real room | **Pass** when built through the game's room-entry path. The plain debug spawn fails. |

## 1. Determinism in Node

`node bench/determinism.js` — 220 scripted episodes of up to 6,000 frames with a random policy. Half start on
floors 1–11 and play normally; half run in god mode and are teleported through every room of the floor.
Coverage per set: 1,231,243 frames, 27 deaths, 58 distinct enemy ids including all 14 boss ids.

| Comparison | Result |
|---|---|
| Full profile, fresh instance per episode, run twice | identical |
| In-instance reset (`new Game()` + `newRun`) vs fresh instance | identical |
| Lean profile (no `audio.js`, `effects.js`) vs full profile | identical |
| Node 18.19.1 vs Node 22.23.1 (22 episodes) | identical |

No exception and no `console.warn` / `console.error` line from the game in any run.

One thing this check caught in the harness itself: the key state lives inside the game's input module, so there
must be exactly one key driver per instance. A second driver on the same instance left keys stuck into the next
episode. `Sim` in `js/core/sim.js` is that driver; the design keeps it one-to-one with the instance.

## 2. Determinism against a browser

`node bench/browser_determinism.js [--detmath]` — the same episodes in headless Chromium, on the game's own
`index.html`, with its `requestAnimationFrame` loop disabled and the frames stepped by hand.

| Math | 44 episodes, 240,589 frames, 54 enemy ids |
|---|---|
| Each engine's own `Math` | **44 of 44 differ.** Episode lengths and death frames still match; values drift from the last bit. |
| `js/core/detmath.js` on both sides | **identical** |

Cause: JavaScript leaves `Math.sin`, `cos`, `tan`, `atan`, `atan2`, `exp`, `log`, `pow`, `acos`, `asin` and others
implementation-defined. Node 22 and Chromium 156 return different last bits for all of them (`sqrt` and `hypot`
agreed). The first divergence is one unit in the last place of the player's velocity on the first moving frame.

`detmath.js` is a prototype that rebuilds those functions from `+ - * /` and `Math.sqrt` only, which are exactly
specified, so every engine gives the same bits.

- Accuracy against Node's own functions on 400,000 samples each: `atan`, `atan2`, `exp`, `log` bit-identical;
  `sin`, `cos` within 1 ulp; `hypot`, `acos`, `asin` within 2; `tan` within 3; `pow` within 21.
- Cost: not measurable. The game makes about 9 such calls per frame plus about 9 `hypot` calls.
- Effect: runs differ from the natively computed game by last-bit rounding (16 of 22 test episodes end in a
  different state). Still deterministic, and the game source is still untouched.
- Known limit: `sin` / `cos` lose accuracy for arguments beyond ±10⁶. Still deterministic.

**Decision (2026-11-13): option 1, for now.** The options were:

1. **Adopt `detmath.js` by default (chosen).** Headless runs, browser replays (R22) and any future browser
   recording agree bit for bit, on any engine and any Node version. Results no longer depend on the V8 build.
2. Keep native math and pin Node to a version whose V8 matches the replay browser. No such pair is known yet,
   and every Node or browser update can break it.

The loader installs the layer by default; `detMath: false` or `BOTA_DETMATH=0` turns it off. Whether it was on
is part of what a run must record (R16), next to the game version.

## 3. Step rate in heavy rooms

`node bench/heavy_rooms.js` — every boss on floors 1 and 11 in god mode for 3,600 frames, boss health cut to
35 % halfway. One core, one timed run per case, so individual numbers vary by some tens of percent.

| Case | Lean, frames/s | Full, frames/s | Peak projectiles |
|---|---|---|---|
| 40 mixed regular enemies, floor 11 (artificial) | 6,400 | 5,200 | 51 |
| 20 mixed regular enemies, floor 11 (artificial) | 11,400 | 10,000 | 41 |
| Octopus Merge | 15,200–20,700 | 14,700–17,300 | 35 |
| Nested Infinite Loop | 20,800–31,500 | 20,100–26,200 | 201 (the cap) |
| Agent Swarm | 26,500–29,100 | 24,200–26,100 | 22 |
| Median over all bosses | 67,900 | 50,300 | |
| Fastest boss (Reviewer) | 105,300 | 83,100 | |

- The slowest real content runs at about 250× real time on one core. No fault in any case.
- The lean profile is about a third faster in heavy rooms, because every hit otherwise spawns particles.

## 4. Memory and instances per process

`node bench/instances.js` — random policy on floor 1, which is mostly quiet rooms, so these are upper bounds.

One process, `K` instances stepped in turn (lean profile):

| K | frames/s, code compiled per instance | frames/s, one shared compiled copy | RSS |
|---|---|---|---|
| 1 | 375,000 | 354,000 | 114 MB |
| 4 | 308,000 | 207,000 | 189 MB |
| 8 | 242,000 | — | 178 MB |
| 16 | 182,000 | 144,000 | 199 MB |
| 64 | 91,000 | 78,000 | 407 MB |

- A Node process costs 44 MB before the game is loaded. Each further instance adds about 4–5 MB.
- Instances that share one compiled copy of the game slow each other down: they have distinct classes, so the
  shared call sites lose their type specialisation. The loader now compiles the game once per instance by default
  (`sharedCode` option for the old behaviour). The remaining loss with large `K` is most likely cache footprint.

Processes in parallel, one instance each:

| Processes | Total frames/s | Total RSS |
|---|---|---|
| 1 | 396,000 | 113 MB |
| 8 | 1,365,000 | 0.9 GB |
| 16 | 1,524,000 | 1.7 GB |
| 32 (oversubscribed) | 1,144,000 | 3.1 GB |

Memory is not a constraint (N2): 32 workers need about 3.6 GB of the 96 GB.

## 5. Bridge cost

`python3 bench/bridge_bench.py` — length-prefixed binary frames over the worker's stdin/stdout, 4 frames per
decision, a 4,096-byte placeholder observation per env, replies read straight into one NumPy batch array.

Round trip without simulation: 22 µs (1 env, 1 KB), 27 µs (1 env, 4 KB), 34 µs (8 envs), 166 µs (64 envs, 256 KB).

Synchronous vector step (send to all workers, then read all):

| Layout | Workers × instances | Envs | Decisions/s | Same loop inside Node, no bridge |
|---|---|---|---|---|
| A: one pipe per process | 16 × 1 | 16 | 33,800–43,200 | 510,000 |
| A | 16 × 4 | 64 | 49,100 | 293,000 |
| A | 16 × 8 | 128 | 46,800–56,800 | 96,000–103,000 |
| A | 8 × 8 | 64 | 49,000 | 94,000 |
| A | 16 × 16 | 256 | 36,800 | 88,000 |
| B: one process, threads + shared memory | 16 × 1 | 16 | 36,100 | 105,000 |
| B | 16 × 4 | 64 | 32,600–44,700 | 61,000–111,000 |
| B | 16 × 8 | 128 | 26,200–43,000 | 49,000–113,000 |

- With one instance per worker the simulation is fast, but Python spends about 23 µs per worker per step, so
  16 workers cannot exceed about 43k decisions/s.
- With more instances per worker the messages are amortised, but the simulation itself slows down sharply once all
  cores are loaded (16 × 8 simulates 5 times slower than 16 × 1). On a 12 MB L3 that looks like cache pressure
  from 128 separate instances; the 7950X3D may behave very differently.
- Layout B (worker threads, one round trip per vector step) was no faster, and its threads simulate much slower
  than separate processes. It also gives weaker isolation. Not pursued.

Best measured: about 45–57k decisions/s (180–230k frames/s, about 3,000–3,800× real time in total).

## 6. Test-room realism

`node bench/test_room.js --seeds 2000` — floor 1, four ways into a fight:

| Way in | Doors close | 0.5 s spawn delay | Clear event fires | Room scored | Doors reopen | Drops after clear |
|---|---|---|---|---|---|---|
| Real room, walking through the door | 2000/2000 | 2000/2000 | 2000/2000 | 2000/2000 | 2000/2000 | 43 % |
| Real room, `game.changeRoom(dir)` | 2000/2000 | 2000/2000 | 2000/2000 | 2000/2000 | 2000/2000 | 43 % |
| Constructed room, `game.changeRoom(dir)` | 2000/2000 | 2000/2000 | 2000/2000 | 2000/2000 | 2000/2000 | 34 % |
| `BOTA.debug.spawn` into the start room | 0/2000 | 2000/2000 | 0/2000 | 0/2000 | n/a | 0 % |

- Walking in and calling `changeRoom` give identical enemy spawns in every seed, with 17 non-play frames on entry
  and 31 frames until the enemies wake.
- The constructed room matches the real one on every measure. Its lower drop rate is expected: the game's clear
  drop is 35 %, and the constructed room has its pipe (about 10 % of rooms) removed on purpose.
- Every floor-1 seed had an unlocked normal room next to the start room, so the builder always has a room to use.
- The naive debug spawn is not a fight in the game's sense: no door closing, no clear event, no score.

## Other findings

- A NaN fed into the game sent it into an endless loop (I caused one by accident in a probe). The worker
  response timeout in the plan is therefore needed, not just a precaution.
- Loading the scripts as one compiled function is about 2.5–3× faster than one `vm` context per instance, and
  produces the same trajectories.

## Proposals

| Topic | Proposal |
|---|---|
| Math | `detmath.js` by default. **Agreed 2026-11-13, for now.** |
| Load profile | `lean` by default: identical trajectories over 1.2M frames, about a third faster in heavy rooms. `full` stays available. **Agreed 2026-11-13, for now.** |
| Process layout | Layout A: one pipe per worker process. Keep `W` and `K` configurable. Start with `W` = number of cores and `K` = 4. |
| Code sharing | Compile per instance (now the loader default). |
| Throughput (N1) | Not fixed yet. Rerun `bench/instances.js` and `bench/bridge_bench.py` on the 7950X3D first. **Deferred 2026-11-13.** |
| If the bridge becomes the limit | Options, in order of effort: fewer syscalls per message, workers that spin briefly instead of sleeping, asynchronous stepping. |

## How to rerun

```
node bench/determinism.js                    # about 3 min
node bench/browser_determinism.js            # needs Playwright in the game checkout (its tools/setup-dev.sh)
node bench/heavy_rooms.js
node bench/instances.js --profile lean
python3 bench/bridge_bench.py --profile lean
node bench/test_room.js --seeds 2000
```

Raw JSON output goes to `bench/results/` (git-ignored).
