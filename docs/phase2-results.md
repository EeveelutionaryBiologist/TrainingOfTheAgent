# Phase 2 results: bridge and Python environment (2026-11-13)

Machine: the dev laptop (i5-1240P, 4 P-cores + 8 E-cores, 16 threads), **CPU governor `powersave`**. It is not the
training machine; absolute numbers here are a lower bound and only the comparisons carry over. Game `v1.0`
(`cc5cba4`), Node 22.23, Python 3.13, Gymnasium 1.4, NumPy 2.5, profile `lean`, math layer on, frame-skip 4.

## Exit criterion

| Criterion | Result |
|---|---|
| Random policy runs across all cores from Python | Yes. 16 workers, 64 envs: 60 s of full runs and 30 s of Bug rooms, 2,459 episodes, 0 faults, 0 worker restarts. |
| Crash and hang injection tests green | Yes: killed worker, stopped worker, a game loop that never returns, a worker dying during reset. `tests/test_faults.py`. |

Tests: 35 in `js/test/` (`npm test`), 29 in `tests/` (`uv run pytest`, about 30 s). Gymnasium's own `check_env`
passes for `BotaEnv`. The browser check still passes (`node bench/browser_determinism.js`): the event counters
added to the Node environment do not change trajectories.

## Throughput through the full Python API

Random policy, `uv run bota-harness bench`. "In worker" is time the worker spent computing, per decision.

| Scenario | Envs | Workers | Decisions/s | Frames/s | ms per vector step | In worker, µs/decision | Reset |
|---|---|---|---|---|---|---|---|
| Bug room, god mode, no resets | 1 | 1 | 11,800 | 47,000 | 0.084 | 20 | – |
| Bug room, god mode, no resets | 64 | 8 | 45,400 | 182,000 | 1.41 | 92 | – |
| Bug room, god mode, no resets | 64 | 16 | 28,000–38,000 | 110,000–153,000 | 1.7–2.3 | 112–141 | – |
| Full runs (time limit 2 min) | 64 | 16 | 43,100 | 172,500 | 1.48 | 90 | 5.7 ms |
| Bug room (reference task) | 64 | 16 | 20,000–27,600 | 80,000–110,000 | 2.3–3.2 | 129–165 | 5.8–7.9 ms |
| Bug room (reference task) | 256 | 16 | 27,500 | 110,000 | 9.3 | 174 | 9.9 ms |

Run-to-run variation on this machine is large (thermal state, background load): the same configuration gave
28,000 and 38,000 decisions/s minutes apart.

What limits it here:

1. **Power management, not the bridge code.** One worker alone needs 20 µs per decision. With 8 to 16 workers
   active the same decision takes 90 to 170 µs inside the worker. Each worker is busy only 20 to 35 % of the time
   (it waits for the next request), and a `powersave` governor keeps lightly used cores at low frequency. Phase 0
   saw the same gap between tight loops (about 42 µs per decision at 16 processes) and bridged stepping.
2. **Sleeping costs more than simulating.** Before `spin_wait`, one env made 2,500 decisions/s: 0.4 ms per round
   trip for 0.065 ms of work, the rest was two wake-ups. With Python busy-waiting for the replies (default up to
   2 ms, then it sleeps) the same env makes 11,800 decisions/s.
3. **Resets are expensive: 6 to 10 ms each inside a loaded worker**, against 1.4 ms measured in Phase 1 in a
   single hot process. A random-policy Bug-room episode is about 375 decisions, so a reset costs as much as 40
   to 60 decisions, and the synchronous vector step waits for it. For short Goal-0 episodes this is the largest
   single cost after power management.

Options measured:

| Option | Effect |
|---|---|
| `spin_wait` (default 2 ms) | One env: 2,500 → 11,800 decisions/s. Many workers: little change; the workers' own wake-up remains. |
| `shared_code=True` (one compiled game per worker instead of one per env) | At 16 envs per worker: reset 9.9 → 5.5 ms, but a decision 174 → 294 µs; overall 9 % slower. At 4 per worker: 8 % slower. Stays off. Trajectories are identical either way (tested). |
| Fewer workers than threads | 8 or 12 workers beat 16 on this CPU (45,000 against 28,000–38,000 at 64 envs). Expected with 4 fast and 8 slow cores; says nothing about the 7950X3D. |

Memory: about 200 MB resident per worker with 4 envs (137 MB with Bug rooms only), flat after the first minute
over 5,000 episodes. 16 workers: about 3.2 GB.

## To settle on the training machine (N1, `W`, `K`)

Still deferred, as agreed on 2026-11-13. The tool is ready:

```
uv run bota-harness bench --envs 64 --workers 16 --secs 30
uv run bota-harness bench --envs 256 --workers 16 --secs 30
uv run bota-harness bench --envs 64 --workers 16 --secs 30 --scenario full_run
```

Questions for that run:

- With the `performance` governor, does "in worker, µs/decision" drop to the single-worker 20 µs range? If yes,
  the expectation is several hundred thousand decisions/s and the bridge stops being the limit.
- What do resets cost there? If they stay in the milliseconds, a cheaper reset path is worth building
  (candidates: keep a pool of pre-built instances per worker; reset out of band so the vector step does not wait).
- `W` and `K`: on this laptop 8 workers with 8 envs each was the best layout.

## Soak results

| Run | Episodes | Ends | Faults | Worker restarts |
|---|---|---|---|---|
| Full runs, 64 envs, 16 workers, 60 s | 1,590 | 216 deaths, 1,374 time limits | 0 | 0 |
| Bug rooms, 64 envs, 16 workers, 30 s | 869 | 406 clears, 448 time limits, 15 deaths | 0 | 0 |
| Full runs, 32 envs, 8 workers, 100 s (memory watch) | 4,982 | – | 0 | 0 |

The random policy clears the two-Bug room in 47 to 52 % of episodes within 60 s of game time (Phase 1: 55 %).
