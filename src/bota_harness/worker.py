"""One Node worker process and the pool of them.

A worker hosts K environments and answers one request at a time over its stdin/stdout pipes. Everything that can
go wrong with the process itself surfaces as `WorkerFailure` (died: `WorkerCrashed`, no answer within the
deadline: `WorkerTimeout`); the vector env replaces the worker and carries on.
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import select
import subprocess
import tempfile
import time
from typing import Any, Sequence

from . import protocol as P
from .errors import WorkerCrashed, WorkerRequestError, WorkerStartError, WorkerTimeout
from .paths import node_binary, worker_script

log = logging.getLogger("bota_harness")

_F_SETPIPE_SZ = 1031
_PIPE_BYTES = 1 << 20
_KEY_FIELDS = ("protocol", "harness", "game", "profile", "detMath", "frameSkip", "recordBytes", "obs", "events",
               "probe", "reasons", "actionNvec", "node")


class Worker:
    """Handle of one worker process. `start()` launches it and sends INIT; `finish_init()` reads the answer."""

    def __init__(self, index: int, k: int, config: dict[str, Any], node: str | None = None):
        self.index, self.k = index, k
        self.config = dict(config, K=k)
        self.node = node
        self.proc: subprocess.Popen | None = None
        self.info: dict[str, Any] = {}
        self._head = bytearray(P.HEAD_BYTES)
        self._head_view = memoryview(self._head)
        # Fixed parts of the hot path: a STEP request without resets, and the reply head of an uneventful step
        self._step_head = P.HEAD.pack(P.HEAD_BYTES - 4 + 4 * k, P.OP_STEP, 4 * k)
        self._plain_reply = b""
        self._plain_total = -1
        self._stderr = None
        self._poll = None
        self._rfd = self._wfd = -1

    # ---- lifecycle ----------------------------------------------------------------------------------------
    def start(self) -> None:
        self._stderr = tempfile.TemporaryFile(prefix="bota-worker-")
        try:
            self.proc = subprocess.Popen([node_binary(self.node), str(worker_script())], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=self._stderr, bufsize=0)
        except OSError as err:
            raise WorkerStartError(f"worker {self.index}: could not start Node: {err}") from err
        self._wfd, self._rfd = self.proc.stdin.fileno(), self.proc.stdout.fileno()
        for fd in (self._wfd, self._rfd):
            try:
                fcntl.fcntl(fd, _F_SETPIPE_SZ, _PIPE_BYTES)
            except OSError:
                pass
        os.set_blocking(self._rfd, False)
        self._poll = select.poll()
        self._poll.register(self._rfd, select.POLLIN)
        self.send(P.OP_INIT, tail=self.config)

    def finish_init(self, deadline: float) -> dict[str, Any]:
        try:
            self.info = self.recv(deadline) or {}
        except WorkerRequestError as err:
            self.kill()
            raise WorkerStartError(f"worker {self.index} refused to start: {err}") from err
        except (WorkerCrashed, WorkerTimeout) as err:
            tail = self.kill()
            raise WorkerStartError(f"worker {self.index} did not start ({err}){': ' + tail if tail else ''}") from err
        if self.info.get("protocol") != P.PROTOCOL:
            self.kill()
            raise WorkerStartError(f"worker speaks protocol {self.info.get('protocol')}, this package {P.PROTOCOL}")
        n = self.k * (int(self.info["recordBytes"]) + int(self.info["obs"]["bytes"]))
        self._plain_reply = P.HEAD.pack(P.HEAD_BYTES - 4 + n, 0, n)
        self._plain_total = P.HEAD_BYTES + n
        return self.info

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc else None

    def stderr_tail(self, limit: int = 2000) -> str:
        if not self._stderr:
            return ""
        try:
            size = self._stderr.seek(0, os.SEEK_END)
            self._stderr.seek(max(0, size - limit))
            return self._stderr.read().decode("utf-8", "replace").strip()
        except (OSError, ValueError):
            return ""

    def kill(self) -> str:
        """Stop the process at once. Returns the end of its stderr output."""
        tail = ""
        if self.proc:
            try:
                self.proc.kill()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                log.error("worker %d (pid %s) did not exit after SIGKILL", self.index, self.proc.pid)
            tail = self.stderr_tail()
            for pipe in (self.proc.stdin, self.proc.stdout):
                try:
                    pipe.close()
                except OSError:
                    pass
        if self._stderr:
            self._stderr.close()
            self._stderr = None
        self.proc = None
        return tail

    def close(self, timeout: float = 3.0) -> None:
        """Ask the worker to exit; kill it if it does not."""
        if not self.proc:
            return
        try:
            self.send(P.OP_CLOSE)
            self.proc.wait(timeout=timeout)
        except (WorkerCrashed, subprocess.TimeoutExpired, OSError):
            pass
        self.kill()

    # ---- requests -----------------------------------------------------------------------------------------
    def send(self, op: int, binary: bytes = b"", tail: Any = None) -> None:
        data = P.pack(op, binary, b"" if tail is None else json.dumps(tail, separators=(",", ":")).encode())
        view, off = memoryview(data), 0
        try:
            while off < len(data):
                off += os.write(self._wfd, view[off:])
        except (BrokenPipeError, OSError) as err:
            raise WorkerCrashed(f"worker {self.index} is gone ({err})") from err

    def _wait(self, deadline: float) -> None:
        left = deadline - time.monotonic()
        if left <= 0:
            raise WorkerTimeout(f"worker {self.index} did not answer in time")
        self._poll.poll(left * 1000.0)

    def _fill(self, views: list[memoryview], deadline: float) -> None:
        """Read until every view is full."""
        views = [v for v in views if len(v)]
        while views:
            try:
                n = os.readv(self._rfd, views)
            except BlockingIOError:
                self._wait(deadline)
                continue
            except InterruptedError:
                continue
            except OSError as err:
                raise WorkerCrashed(f"worker {self.index}: read failed ({err})") from err
            if n == 0:
                code = self.proc.poll() if self.proc else None
                raise WorkerCrashed(f"worker {self.index} closed its pipe" + (f" (exit code {code})" if code is not None else ""))
            while n:
                first = views[0]
                if n >= len(first):
                    n -= len(first)
                    views.pop(0)
                else:
                    views[0] = first[n:]
                    n = 0

    def recv(self, deadline: float, binary: Sequence[memoryview] = ()) -> Any:
        """Read one reply. Its binary part goes straight into `binary` (caller-owned memory, total size must
        match); the JSON part is returned (None if empty). Raises WorkerRequestError for an error reply."""
        expect = sum(len(v) for v in binary)
        self._fill([self._head_view], deadline)
        length, status, bin_len = P.HEAD.unpack(self._head)
        body = length - (P.HEAD_BYTES - 4)
        if status == 0 and bin_len == expect:
            if expect:
                self._fill(list(binary), deadline)
            tail_len = body - bin_len
            if not tail_len:
                return None
            tail = bytearray(tail_len)
            self._fill([memoryview(tail)], deadline)
            return json.loads(tail)
        payload = bytearray(max(0, body))
        self._fill([memoryview(payload)], deadline)
        if status != 0:
            try:
                err = json.loads(payload[bin_len:])
            except ValueError:
                err = {"error": payload[bin_len:].decode("utf-8", "replace")}
            raise WorkerRequestError(str(err.get("error")), err.get("name") or "Error", err.get("stack"))
        raise WorkerRequestError(f"worker {self.index} sent {bin_len} binary bytes where {expect} were expected")

    def send_step(self, actions: memoryview) -> None:
        """STEP without resets: `actions` is this worker's K*4 action bytes, sent without copying."""
        try:
            n = os.writev(self._wfd, (self._step_head, actions))
            if n != P.HEAD_BYTES + len(actions):   # the pipe was full; finish the frame the slow way
                data = (self._step_head + bytes(actions))[n:]
                while data:
                    data = data[os.write(self._wfd, data):]
        except (BrokenPipeError, OSError) as err:
            raise WorkerCrashed(f"worker {self.index} is gone ({err})") from err

    def recv_step(self, deadline: float, spin_until: float, views: tuple[memoryview, ...]) -> Any:
        """Reply to a STEP or RESET: the binary part goes into `views` (records, then observations), the JSON
        part (rare) is returned.

        Busy-waits until `spin_until` before sleeping in poll(): a sleeping reader costs a wake-up per worker
        and step, which on power-saving CPUs is longer than the simulation itself."""
        monotonic = time.monotonic
        while True:
            try:
                got = os.readv(self._rfd, (self._head_view, *views))
                break
            except BlockingIOError:
                if monotonic() >= spin_until:
                    self._wait(deadline)
            except InterruptedError:
                pass
            except OSError as err:
                raise WorkerCrashed(f"worker {self.index}: read failed ({err})") from err
        if got == self._plain_total and self._head == self._plain_reply:
            return None
        return self._recv_rest(got, deadline, views)

    def _recv_rest(self, got: int, deadline: float, views: tuple[memoryview, ...]) -> Any:
        """Everything recv_step's fast path does not cover: partial reads, a JSON part, error replies."""
        if got == 0:
            code = self.proc.poll() if self.proc else None
            raise WorkerCrashed(f"worker {self.index} closed its pipe" + (f" (exit code {code})" if code is not None else ""))
        if got < P.HEAD_BYTES:
            self._fill([self._head_view[got:]], deadline)
            got = P.HEAD_BYTES
        spilled = got - P.HEAD_BYTES              # bytes after the head that already landed in `views`
        expect = sum(len(v) for v in views)
        length, status, bin_len = P.HEAD.unpack(self._head)
        body = length - (P.HEAD_BYTES - 4)
        if status == 0 and bin_len == expect:
            rest, skip = [], spilled
            for v in views:
                if skip >= len(v):
                    skip -= len(v)
                else:
                    rest.append(v[skip:])
                    skip = 0
            self._fill(rest, deadline)
            tail = bytearray(body - bin_len)
            if not tail:
                return None
            self._fill([memoryview(tail)], deadline)
            return json.loads(tail)
        # Not the expected shape: what landed in `views` is the start of the payload, not records
        payload = bytearray(max(body, spilled))
        at = 0
        for v in views:
            n = min(len(v), spilled - at)
            if n <= 0:
                break
            payload[at:at + n] = v[:n]
            v[:n] = bytes(n)
            at += n
        self._fill([memoryview(payload)[spilled:]], deadline)
        if status != 0:
            try:
                err = json.loads(payload[bin_len:])
            except ValueError:
                err = {"error": payload[bin_len:].decode("utf-8", "replace")}
            raise WorkerRequestError(str(err.get("error")), err.get("name") or "Error", err.get("stack"))
        raise WorkerRequestError(f"worker {self.index} sent {bin_len} binary bytes where {expect} were expected")

    def request(self, op: int, tail: Any, timeout: float) -> Any:
        """Send a JSON-only request and return the JSON answer."""
        self.send(op, tail=tail)
        return self.recv(time.monotonic() + timeout)


class WorkerPool:
    """`num_envs` environments spread over `workers` processes, in contiguous blocks."""

    def __init__(self, num_envs: int, workers: int, config: dict[str, Any], *, node: str | None = None,
                 init_timeout: float = 120.0):
        if num_envs < 1:
            raise ValueError("num_envs must be at least 1")
        if not 1 <= workers <= num_envs:
            raise ValueError(f"workers must be in 1..num_envs ({num_envs}), got {workers}")
        self.num_envs, self.config, self.node, self.init_timeout = num_envs, dict(config), node, init_timeout
        base, extra = divmod(num_envs, workers)
        self.slices: list[slice] = []
        start = 0
        for w in range(workers):
            k = base + (1 if w < extra else 0)
            self.slices.append(slice(start, start + k))
            start += k
        self.workers: list[Worker] = [Worker(w, s.stop - s.start, self.config, node) for w, s in enumerate(self.slices)]
        self.info: dict[str, Any] = {}
        try:
            for w in self.workers:
                w.start()
            deadline = time.monotonic() + init_timeout
            for w in self.workers:
                w.finish_init(deadline)
        except BaseException:
            self.close()
            raise
        self.info = self.workers[0].info
        for w in self.workers[1:]:
            for key in _KEY_FIELDS:
                if w.info.get(key) != self.info.get(key):
                    self.close()
                    raise WorkerStartError(f"workers disagree on {key!r}: {w.info.get(key)!r} vs {self.info.get(key)!r}")

    def __len__(self) -> int:
        return len(self.workers)

    def worker_of(self, env_index: int) -> int:
        for w, s in enumerate(self.slices):
            if s.start <= env_index < s.stop:
                return w
        raise IndexError(env_index)

    def restart(self, w: int) -> str:
        """Kill worker `w` and start a fresh one in its place. Returns the dead worker's last stderr output."""
        tail = self.workers[w].kill()
        s = self.slices[w]
        fresh = Worker(w, s.stop - s.start, self.config, self.node)
        fresh.start()
        fresh.finish_init(time.monotonic() + self.init_timeout)
        for key in _KEY_FIELDS:
            if fresh.info.get(key) != self.info.get(key):
                fresh.kill()
                raise WorkerStartError(f"restarted worker disagrees on {key!r}")
        self.workers[w] = fresh
        return tail

    def close(self) -> None:
        for w in self.workers:
            try:
                if w.proc:
                    w.send(P.OP_CLOSE)
            except (WorkerCrashed, OSError):
                pass
        deadline = time.monotonic() + 3.0
        for w in self.workers:
            if w.proc:
                try:
                    w.proc.wait(timeout=max(0.05, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    pass
            w.kill()
