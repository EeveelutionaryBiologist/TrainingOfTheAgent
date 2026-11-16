"""Exceptions of the harness."""
from __future__ import annotations


class HarnessError(RuntimeError):
    """Base class of everything this package raises on its own."""


class ScenarioError(HarnessError, ValueError):
    """The scenario is invalid (unknown enemy id, bad layout, ...). Retrying cannot help."""


class ResetError(HarnessError):
    """No episode could be started within the allowed number of attempts."""


class WorkerStartError(HarnessError):
    """A worker process did not come up (Node missing, game checkout not the pinned version, ...)."""


class WorkerRequestError(HarnessError):
    """A worker refused a request. The worker is still running; the request had no effect."""

    def __init__(self, message: str, name: str = "Error", stack: str | None = None):
        super().__init__(message)
        self.name = name
        self.stack = stack


class WorkerFailure(HarnessError):
    """A worker died or stopped answering. Handled inside the vector env (the worker is replaced)."""

    kind = "worker_failure"


class WorkerCrashed(WorkerFailure):
    kind = "worker_crash"


class WorkerTimeout(WorkerFailure):
    kind = "worker_hang"
