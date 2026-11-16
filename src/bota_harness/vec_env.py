"""BotaVecEnv: the game behind the Gymnasium vector API (R2, R14).

`num_envs` environments run in `workers` Node processes. One `step()` sends every worker its actions, lets them
simulate in parallel and reads the answers back into shared NumPy arrays.

What the caller gets
    observation   a placeholder for now: `{"none": zeros}`. The fair observation (REQUIREMENTS §3.3) is Phase 3;
                  until then nothing about the game reaches the observation, and `describe()["obs"]` says
                  `{"id": "none", "version": 0}`. (Gymnasium does not accept an empty observation space.)
    reward        from the Task, computed from privileged event counters (and the probe if the task asks for it)
    info          reason, play_frames, frames, decisions, events, reset; `probe` if enabled; `result` and `success`
                  when an episode ends; `fault` when a game error or a worker failure ended it

Autoreset follows Gymnasium's NEXT_STEP convention: the call after the one that ended an episode starts the next
episode, ignores the action and returns reward 0. With `AutoresetMode.DISABLED` the caller resets finished
environments itself through `reset(options={"reset_mask": mask})`.

Faults never raise out of `step()` (R6, N4): a game exception ends that one episode as truncated; a worker that
died or hangs is killed and replaced, and its environments report a truncated episode. Each is logged with seed
and frame and kept in `fault_log`.
"""
from __future__ import annotations

import logging
import os
import time
from collections import deque
from dataclasses import replace
from typing import Any, Mapping

import numpy as np
from gymnasium import spaces
from gymnasium.vector import AutoresetMode, VectorEnv
from gymnasium.vector.utils import batch_space

from . import protocol as P
from .errors import HarnessError, ResetError, ScenarioError, WorkerFailure, WorkerRequestError
from .scenario import Scenario, random_seed, to_dict
from .task import Columns, EpisodeResult, StepData, Task
from .worker import WorkerPool

log = logging.getLogger("bota_harness")

_NVEC = np.array(P.ACTION_NVEC, dtype=np.int64)


class BotaVecEnv(VectorEnv):
    """Vector environment over the pinned game.

    Args:
        num_envs: number of environments.
        task: scenario source, reward and success criterion; default `Task()` (full runs, reward 0).
        workers: Node processes to spread the environments over; default min(num_envs, CPU count).
        frame_skip: play frames one decision is held for (R4).
        probe: include the raw state probe in `info` and hand it to the task. Default: only if the task needs it.
        record: keep the key events of each episode so `transcript(i)` can return a replayable recording.
        autoreset_mode: `AutoresetMode.NEXT_STEP` (default) or `AutoresetMode.DISABLED`.
        profile: load profile of the game, "lean" (default) or "full"; trajectories are identical.
        det_math: engine-independent math layer (default on; needed for Node/browser agreement).
        game_dir: game checkout; default $BOTA_GAME_DIR, then ../BindingOfTheAgent next to the harness repo.
        allow_unpinned: run a checkout that is not the pinned version (recorded in `describe()`).
        console_faults: which console output of the game ends an episode as a fault: "error", "warn" or "off".
        step_timeout: seconds a worker may take for one request before it counts as hung.
        spin_wait: seconds `step()` busy-waits for the workers before it sleeps. Sleeping costs a wake-up per
            step, which on power-saving CPUs is far longer than the simulation; set 0 to never busy-wait.
        shared_code: let all environments of a worker share one compiled copy of the game (default: one copy
            each). Shared code makes resets cheaper and steps slower; see docs/phase2-results.md.
        max_reset_retries: further attempts when a scenario does not work with the seed drawn for it.
        max_worker_restarts: consecutive failures of one worker before the env gives up and raises.
    """

    metadata = {"render_modes": [], "autoreset_mode": AutoresetMode.NEXT_STEP}

    def __init__(self, num_envs: int = 1, task: Task | None = None, *, workers: int | None = None,
                 frame_skip: int = 4, probe: bool | None = None, record: bool = False,
                 autoreset_mode: AutoresetMode = AutoresetMode.NEXT_STEP, profile: str = "lean",
                 det_math: bool = True, game_dir: str | os.PathLike | None = None, allow_unpinned: bool = False,
                 console_faults: str = "error", step_timeout: float = 30.0, init_timeout: float = 120.0,
                 spin_wait: float = 0.002, shared_code: bool = False,
                 max_reset_retries: int = 8, max_worker_restarts: int = 3, node: str | None = None,
                 _test_hooks: bool = False):
        if autoreset_mode not in (AutoresetMode.NEXT_STEP, AutoresetMode.DISABLED):
            raise ValueError("autoreset_mode must be AutoresetMode.NEXT_STEP or AutoresetMode.DISABLED")
        self.num_envs = int(num_envs)
        self.task = task if task is not None else Task()
        self.autoreset_mode = autoreset_mode
        self.metadata = dict(type(self).metadata, autoreset_mode=autoreset_mode)
        self.step_timeout = float(step_timeout)
        self.spin_wait = max(0.0, float(spin_wait))
        self.max_reset_retries = int(max_reset_retries)
        self.max_worker_restarts = int(max_worker_restarts)
        want_probe = bool(self.task.needs_probe) if probe is None else bool(probe)
        if self.task.needs_probe and not want_probe:
            raise ValueError(f"task {self.task.name!r} needs the probe, but probe=False was passed")
        n_workers = min(self.num_envs, os.cpu_count() or 1) if workers is None else int(workers)
        config = {
            "frameSkip": int(frame_skip), "record": bool(record), "probe": want_probe, "profile": profile,
            "detMath": bool(det_math), "gameDir": os.fspath(game_dir) if game_dir is not None else None,
            "allowUnpinned": bool(allow_unpinned), "consoleFaults": console_faults, "testHooks": bool(_test_hooks),
            "sharedCode": bool(shared_code),
        }
        self._pool = WorkerPool(self.num_envs, n_workers, config, node=node, init_timeout=init_timeout)
        info = self._pool.info
        if tuple(info["reasons"]) != P.REASONS or tuple(info["actionNvec"]) != P.ACTION_NVEC:
            self._pool.close()
            raise HarnessError("the Node side and the Python side disagree on reasons or the action space")

        self.event_names: tuple[str, ...] = tuple(info["events"])
        self.probe_names: tuple[str, ...] = tuple(info["probe"])
        self.room_types: tuple[str, ...] = tuple(info["roomTypes"])
        self.frame_skip = int(info["frameSkip"])
        self.record = bool(record)

        self.single_action_space = spaces.MultiDiscrete(list(P.ACTION_NVEC))
        self.action_space = batch_space(self.single_action_space, self.num_envs)
        self.single_observation_space = spaces.Dict({"none": spaces.Box(0, 0, shape=(1,), dtype=np.uint8)})
        self.observation_space = batch_space(self.single_observation_space, self.num_envs)

        n = self.num_envs
        dtype = P.record_dtype(len(self.event_names), len(self.probe_names))
        if dtype.itemsize != info["recordBytes"]:
            self._pool.close()
            raise HarnessError(f"record size mismatch: worker {info['recordBytes']} bytes, Python {dtype.itemsize}")
        self._records = np.zeros(n, dtype=dtype)
        raw = self._records.view(np.uint8).reshape(n, dtype.itemsize)
        self._views = [memoryview(raw[s]).cast("B") for s in self._pool.slices]
        self._scratch = [np.zeros(s.stop - s.start, dtype=dtype) for s in self._pool.slices]
        self._scratch_views = [memoryview(x.view(np.uint8)).cast("B") for x in self._scratch]
        self._busy = False     # True while replies are outstanding; an interrupted exchange leaves it set
        self._needs_reset = np.ones(n, dtype=bool)
        self._scenarios: list[dict[str, Any] | None] = [None] * n
        self._episode_index = np.zeros(n, dtype=np.int64)     # episodes started so far, per env
        self._ep_return = np.zeros(n, dtype=np.float64)
        self._ep_events = np.zeros((n, len(self.event_names)), dtype=np.float64)
        self._rngs: list[np.random.Generator] | None = None
        self._base_seed: Any = None
        self._restarts = [0] * len(self._pool)
        self._step_faults: dict[int, dict[str, Any]] = {}

        self.fault_log: deque[dict[str, Any]] = deque(maxlen=1000)
        self.fault_count = 0
        self.worker_restarts = 0
        self.closed = False

    # ---- description (R16) --------------------------------------------------------------------------------
    def describe(self) -> dict[str, Any]:
        """Everything that identifies how results from this environment were produced."""
        info = self._pool.info
        return {
            "harness": info["harness"], "protocol": info["protocol"], "game": info["game"],
            "profile": info["profile"], "det_math": info["detMath"], "frame_skip": info["frameSkip"],
            "node": info["node"], "obs": info["obs"], "events": list(self.event_names),
            "probe": list(self.probe_names), "task": self.task.describe(),
            "shared_code": bool(self._pool.config.get("sharedCode")),
            "num_envs": self.num_envs, "workers": len(self._pool), "seed": self._base_seed,
            "autoreset_mode": self.autoreset_mode.value,
        }

    @property
    def scenarios(self) -> list[dict[str, Any] | None]:
        """The scenario each environment is running (or last ran)."""
        return list(self._scenarios)

    @property
    def worker_pids(self) -> list[int | None]:
        return [w.pid for w in self._pool.workers]

    # ---- reset --------------------------------------------------------------------------------------------
    def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None):
        """Start episodes.

        seed: seeds the per-environment generators that scenario seeds are drawn from (and resets the episode
              counters). Omit it to continue the existing streams.
        options["scenario"]: one scenario for all environments, or a list with one per environment, used for
              this reset instead of the task's.
        options["reset_mask"]: boolean array; reset only these environments.
        """
        self._require_open()
        n = self.num_envs
        if seed is not None and not isinstance(seed, (int, np.integer)):
            raise TypeError("seed must be an int or None; per-environment streams are derived from it")
        if seed is not None or self._rngs is None:
            ss = np.random.SeedSequence(None if seed is None else int(seed))
            children = ss.spawn(n + 1)
            self._rngs = [np.random.default_rng(c) for c in children[:n]]
            self._np_random = np.random.default_rng(children[n])
            self._np_random_seed = self._base_seed = ss.entropy
            self._episode_index[:] = 0
        options = dict(options or {})
        mask = options.pop("reset_mask", None)
        if mask is None:
            mask = np.ones(n, dtype=bool)
        else:
            mask = np.asarray(mask)
            if mask.shape != (n,) or mask.dtype != np.bool_:
                raise ValueError(f"options['reset_mask'] must be a boolean array of shape ({n},)")
            if not mask.any():
                raise ValueError("options['reset_mask'] selects no environment")
        given = options.pop("scenario", None)
        if options:
            raise ValueError(f"unknown reset options: {sorted(options)}")
        overrides: dict[int, Scenario] = {}
        if given is not None:
            if isinstance(given, (list, tuple)):
                if len(given) != n:
                    raise ValueError(f"options['scenario'] as a list needs {n} entries, got {len(given)}")
                overrides = {i: given[i] for i in np.flatnonzero(mask)}
            else:
                overrides = {int(i): given for i in np.flatnonzero(mask)}
        self._step_faults = {}
        self._reset_envs([int(i) for i in np.flatnonzero(mask)], overrides, {})
        scenarios = np.full(n, None, dtype=object)
        for i in np.flatnonzero(mask):
            scenarios[i] = self._scenarios[i]
        info: dict[str, Any] = {"scenario": scenarios, "_scenario": mask.copy()}
        if self.probe_names:
            info["probe"] = self._records["probe"].copy()
        if self._step_faults:
            # A worker failed during a partial reset and took running episodes of other environments with it.
            # They are over (see fault_log) and start again at the next step, or need a reset in DISABLED mode.
            faults = np.full(n, None, dtype=object)
            for i, f in self._step_faults.items():
                faults[i] = f
            info["fault"] = faults
            info["_fault"] = np.array([f is not None for f in faults])
        return {"none": np.zeros((self.num_envs, 1), dtype=np.uint8)}, info

    def _draw_scenario(self, i: int, override: Scenario | None) -> dict[str, Any]:
        source = override if override is not None else self.task.scenario(self._rngs[i], i, int(self._episode_index[i]))
        sc = to_dict(source)
        if not sc.get("seed"):
            sc["seed"] = random_seed(self._rngs[i])
        return sc

    def _reset_envs(self, indices: list[int], overrides: Mapping[int, Scenario], failed: dict[int, dict[str, Any]]) -> None:
        """Give every environment in `indices` a running episode. `failed` maps environments to the scenario
        that just failed for them (so an identical retry is refused)."""
        pool = self._pool
        pending = list(indices)
        attempts = 0
        last_error = ""
        while pending:
            attempts += 1
            if attempts > self.max_reset_retries + 1:
                raise ResetError(f"no episode could be started for environments {pending} after {attempts - 1} attempts"
                                 f"{': ' + last_error if last_error else ''}")
            # Draw every scenario before anything is sent: a refusal here must not leave replies unread
            plan: dict[int, list[int]] = {}
            for i in pending:
                sc = self._draw_scenario(i, overrides.get(i))
                if failed.get(i) == sc:
                    raise ResetError(f"environment {i}: the scenario with seed {sc['seed']} cannot be started "
                                     f"({last_error or 'see fault_log'}) and its source offers no other")
                self._scenarios[i] = sc
                plan.setdefault(pool.worker_of(i), []).append(i)
            failures: dict[int, WorkerFailure] = {}
            sent: list[int] = []
            self._busy = True
            for w, idxs in plan.items():
                start = pool.slices[w].start
                try:
                    pool.workers[w].send(P.OP_RESET, tail={"resets": [[i - start, self._scenarios[i]] for i in idxs]})
                    sent.append(w)
                except WorkerFailure as err:
                    failures[w] = err
            deadline = time.monotonic() + self.step_timeout
            retry: list[int] = []
            error: Exception | None = None
            for w in sent:
                start = pool.slices[w].start
                try:
                    # Into scratch memory: only the records of the environments being reset are taken over
                    reply = pool.workers[w].recv_step(deadline, 0.0, self._scratch_views[w])
                except WorkerFailure as err:
                    failures[w] = err
                    continue
                except WorkerRequestError as err:
                    error = error or err
                    continue
                self._restarts[w] = 0
                for res in reply["resets"]:
                    i = start + res["i"]
                    self._records[i] = self._scratch[w][res["i"]]
                    if res["ok"]:
                        self._needs_reset[i] = False
                        self._episode_index[i] += 1
                        self._ep_return[i] = 0.0
                        self._ep_events[i] = 0.0
                        continue
                    last_error = str(res.get("error"))
                    if not res.get("retryable"):
                        error = error or ScenarioError(f"environment {i}: {last_error}")
                        continue
                    if res.get("fault"):
                        self._log_fault(i, dict(res["fault"], during="reset"))
                    failed[i] = self._scenarios[i]
                    retry.append(i)
            self._busy = False
            for w, err in failures.items():
                self._recover(w, err, resetting=set(plan[w]))
                last_error = str(err)
                retry.extend(plan[w])
            if error is not None:
                raise error
            pending = sorted(retry)

    # ---- step ---------------------------------------------------------------------------------------------
    def step(self, actions):
        self._require_open()
        n = self.num_envs
        if self._rngs is None:
            raise HarnessError("step() before reset()")
        a = np.asarray(actions)
        if a.shape != (n, 4):
            raise ValueError(f"actions must have shape ({n}, 4), got {a.shape}")
        if not np.issubdtype(a.dtype, np.integer):
            raise TypeError(f"actions must be integers, got dtype {a.dtype}")
        if ((a < 0) | (a >= _NVEC)).any():
            raise ValueError(f"actions outside the action space {list(P.ACTION_NVEC)}")
        a8 = np.ascontiguousarray(a, dtype=np.uint8)
        abytes = memoryview(a8).cast("B")

        pool = self._pool
        resetting = self._needs_reset.copy()
        any_reset = bool(resetting.any())
        if any_reset and self.autoreset_mode is AutoresetMode.DISABLED:
            raise HarnessError(f"environments {np.flatnonzero(resetting).tolist()} have no running episode; "
                               "reset them with reset(options={'reset_mask': mask})")
        tails: list[dict[str, Any] | None] = [None] * len(pool)
        if any_reset:
            # Draw every scenario before anything is sent: a refusal here must not leave replies unread
            for i in np.flatnonzero(resetting):
                i = int(i)
                self._scenarios[i] = self._draw_scenario(i, None)
                w = pool.worker_of(i)
                tails[w] = tails[w] or {"resets": []}
                tails[w]["resets"].append([i - pool.slices[w].start, self._scenarios[i]])
        self._step_faults = {}
        failed: dict[int, dict[str, Any]] = {}
        failures: dict[int, WorkerFailure] = {}
        self._busy = True
        workers = pool.workers
        for w, s in enumerate(pool.slices):
            try:
                if tails[w] is None:
                    workers[w].send_step(abytes[4 * s.start:4 * s.stop])
                else:
                    workers[w].send(P.OP_STEP, abytes[4 * s.start:4 * s.stop].tobytes(), tails[w])
            except WorkerFailure as err:
                failures[w] = err
        now = time.monotonic()
        deadline = now + self.step_timeout
        spin_until = now + self.spin_wait
        not_started: list[int] = []
        retry: list[int] = []
        error: Exception | None = None
        for w, s in enumerate(pool.slices):
            if w in failures:
                continue
            try:
                notes = workers[w].recv_step(deadline, spin_until, self._views[w])
            except WorkerFailure as err:
                failures[w] = err
                continue
            except WorkerRequestError as err:
                # The worker refused the whole request, so none of its environments moved: a bug in the harness,
                # not in the game. Finish reading the other workers, then let the caller see it.
                error = error or err
                continue
            if notes is None:
                continue
            if notes:
                for f in notes.get("faults", ()):
                    i = s.start + f["i"]
                    self._step_faults[i] = f["fault"]
                    self._log_fault(i, f["fault"])
                for res in notes.get("resets", ()):
                    i = s.start + res["i"]
                    not_started.append(i)
                    if not res.get("retryable"):
                        error = error or ScenarioError(f"environment {i}: {res.get('error')}")
                        continue
                    if res.get("fault"):
                        self._log_fault(i, dict(res["fault"], during="reset"))
                    failed[i] = self._scenarios[i]
                    retry.append(i)
        self._busy = False
        if not failures and any(self._restarts):
            self._restarts = [0] * len(pool)
        if any_reset:
            started = resetting.copy()
            started[not_started] = False
            for w in failures:
                started[pool.slices[w]] = False
            self._needs_reset[started] = False
            self._episode_index[started] += 1
            self._ep_return[started] = 0.0
            self._ep_events[started] = 0.0
        for w, err in failures.items():
            s = pool.slices[w]
            was_resetting = {i for i in range(s.start, s.stop) if resetting[i]}
            self._recover(w, err, resetting=was_resetting)
            retry.extend(was_resetting)
        if error is not None:
            raise error
        if retry:
            self._reset_envs(sorted(retry), {}, failed)
        return self._collect()

    def _collect(self):
        """Turn the records of the call just made into the Gymnasium step result."""
        n = self.num_envs
        rec = self._records.copy()     # one copy; everything handed out below is a view of it
        flags = rec["flags"]
        terminated = (flags & P.FLAG_TERMINATED).view(np.bool_)
        truncated = (flags & P.FLAG_TRUNCATED) != 0
        reset = (flags & P.FLAG_RESET) != 0
        reason = rec["reason"]
        events = rec["events"]
        probe = rec["probe"] if self.probe_names else None
        step = StepData(Columns(events, self.event_names), Columns(probe, self.probe_names) if probe is not None else None,
                        terminated, truncated, reason, reset)
        reward = np.array(self.task.reward(step), dtype=np.float64)
        if reward.shape != (n,):
            if reward.shape != ():
                raise HarnessError(f"task {self.task.name!r}: reward() must return {n} values, got shape {reward.shape}")
            reward = np.full(n, float(reward))
        reward[reset] = 0.0
        self._ep_return += reward
        self._ep_events += events

        info: dict[str, Any] = {
            "reason": reason, "reset": reset, "events": events,
            "play_frames": rec["play_frames"], "frames": rec["frames"], "decisions": rec["decisions"],
        }
        if probe is not None:
            info["probe"] = probe
        done = terminated | truncated
        if done.any():
            results = np.full(n, None, dtype=object)
            success = np.zeros(n, dtype=bool)
            for i in np.flatnonzero(done):
                i = int(i)
                sc = self._scenarios[i] or {}
                result = EpisodeResult(
                    env_index=i, episode_index=int(self._episode_index[i]) - 1, scenario=sc, seed=str(sc.get("seed", "")),
                    reason=P.REASONS[reason[i]], terminated=bool(terminated[i]), truncated=bool(truncated[i]),
                    play_frames=int(rec["play_frames"][i]), frames=int(rec["frames"][i]), decisions=int(rec["decisions"][i]),
                    total_reward=float(self._ep_return[i]),
                    events={name: float(v) for name, v in zip(self.event_names, self._ep_events[i])},
                    fault=self._step_faults.get(i),
                )
                verdict = self.task.success(result)
                if verdict is not None:
                    result = replace(result, success=bool(verdict))
                    success[i] = bool(verdict)
                results[i] = result
            info["result"] = results
            info["_result"] = done
            info["success"] = success
            info["_success"] = done
            self._needs_reset |= done
        if self._step_faults:
            faults = np.full(n, None, dtype=object)
            mask = np.zeros(n, dtype=bool)
            for i, f in self._step_faults.items():
                faults[i] = f
                mask[i] = True
            info["fault"] = faults
            info["_fault"] = mask
        return {"none": np.zeros((self.num_envs, 1), dtype=np.uint8)}, reward, terminated, truncated, info

    # ---- faults -------------------------------------------------------------------------------------------
    def _log_fault(self, i: int, fault: dict[str, Any]) -> None:
        sc = self._scenarios[i] or {}
        entry = dict(fault, env_index=i, episode_index=int(self._episode_index[i]), seed=fault.get("seed") or sc.get("seed"))
        entry.setdefault("scenario", sc)
        self.fault_log.append(entry)
        self.fault_count += 1
        log.warning("env %d: %s fault%s, seed %s, frame %s, state %s: %s", i, entry.get("kind"),
                    " during reset" if entry.get("during") == "reset" else "", entry.get("seed"), entry.get("frame"),
                    entry.get("state"), entry.get("message"))

    def _recover(self, w: int, failure: WorkerFailure, resetting: set[int]) -> None:
        """Replace worker `w`. Its environments that were in the middle of an episode report that episode as
        truncated by a fault and wait for a reset; those in `resetting` are left for the caller to start again."""
        self._restarts[w] += 1
        self.worker_restarts += 1
        if self._restarts[w] > self.max_worker_restarts:
            raise HarnessError(f"worker {w} failed {self._restarts[w]} times in a row, giving up: {failure}") from failure
        old_pid = self._pool.workers[w].pid
        stderr = self._pool.restart(w)
        log.warning("worker %d (pid %s) replaced after %s: %s%s", w, old_pid, failure.kind, failure,
                    f"\n--- last stderr ---\n{stderr}" if stderr else "")
        s = self._pool.slices[w]
        rec = self._records
        for i in range(s.start, s.stop):
            if i in resetting or self._needs_reset[i]:
                continue
            rec["flags"][i] = P.FLAG_TRUNCATED | P.FLAG_FAULT
            rec["reason"][i] = P.REASON_FAULT
            rec["events"][i] = 0.0
            self._needs_reset[i] = True
            sc = self._scenarios[i] or {}
            fault = {"kind": failure.kind, "message": str(failure), "worker": w, "pid": old_pid, "stderr": stderr or None,
                     "frame": int(rec["frames"][i]), "state": None, "seed": sc.get("seed"), "scenario": sc}
            self._step_faults[i] = fault
            self._log_fault(i, fault)

    # ---- privileged access --------------------------------------------------------------------------------
    def _request(self, i: int, op: int, tail: dict[str, Any]) -> Any:
        self._require_open()
        if not 0 <= i < self.num_envs:
            raise IndexError(f"environment index {i} out of range")
        w = self._pool.worker_of(i)
        return self._pool.workers[w].request(op, dict(tail, i=i - self._pool.slices[w].start), self.step_timeout)

    def call(self, i: int, fn: str, *args: Any) -> Any:
        """PRIVILEGED control call on environment `i` (js/core/control.js): `snapshot`, `signature`, and the game's
        debug hooks `god`, `giveItem`, `resources`, `spawn`, `spawnBoss`, `gotoRoom`, `nextFloor`, `killAll`.
        Not reachable through the action space. A call that changes the game marks the episode as tampered."""
        return self._request(i, P.OP_CALL, {"fn": fn, "args": list(args)})["result"]

    def snapshot(self, i: int) -> dict[str, Any]:
        """PRIVILEGED: detailed raw state of environment `i`, for debugging and tests."""
        return self.call(i, "snapshot")

    def signature(self, i: int) -> str:
        """Hash of the gameplay state of environment `i` (the one transcripts end with)."""
        return self.call(i, "signature")

    def transcript(self, i: int) -> dict[str, Any]:
        """Recording of environment `i`'s current or just finished episode (needs record=True). It holds the
        scenario and every key event and replays in Node or in the real game in a browser (R22)."""
        if not self.record:
            raise HarnessError("no recording: create the environment with record=True")
        return self._request(i, P.OP_TRANSCRIPT, {})["transcript"]

    def worker_stats(self) -> list[dict[str, Any]]:
        """Per worker: requests, steps, resets, seconds spent computing steps (`busySeconds`, resets included),
        seconds spent in resets, game instances built, resident memory. For benchmarks."""
        self._require_open()
        return [w.request(P.OP_STATS, None, self.step_timeout) for w in self._pool.workers]

    # ---- shutdown -----------------------------------------------------------------------------------------
    def _require_open(self) -> None:
        if self.closed:
            raise HarnessError("the environment is closed")
        if self._busy:
            raise HarnessError("an earlier call was interrupted while workers were answering; close this environment and create a new one")

    def close_extras(self, **kwargs: Any) -> None:
        self._pool.close()

    def __del__(self) -> None:
        pool = getattr(self, "_pool", None)
        if pool is not None and not getattr(self, "closed", True):
            try:
                pool.close()
            except Exception:   # interpreter shutdown
                pass
