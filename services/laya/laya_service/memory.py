"""Explicit process memory accounting. OOM is reported, never converted into a backend fallback."""

from __future__ import annotations

import os
import resource
import sys

from .errors import MemoryBudgetError


def rss_bytes() -> int:
    if sys.platform == "linux":
        status = PathStatus()
        if status is not None:
            return status
    usage = resource.getrusage(resource.RUSAGE_SELF)
    rss = int(usage.ru_maxrss)
    if sys.platform == "darwin":
        return rss
    return rss * 1024


def PathStatus() -> int | None:
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    parts = line.split()
                    return int(parts[1]) * 1024
    except OSError:
        return None
    return None


def rss_mb() -> int:
    return int(rss_bytes() / (1024 * 1024))


def apply_memory_budget(budget_mb: int) -> None:
    if budget_mb <= 0:
        return
    cap = budget_mb * 1024 * 1024
    try:
        current = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (cap, cap if current[1] == resource.RLIM_INFINITY else min(cap, current[1])))
    except (ValueError, OSError):
        # Darwin may refuse RLIMIT_AS; health still reports RSS against the budget.
        pass


def raise_if_over_budget(budget_mb: int) -> None:
    if budget_mb <= 0:
        return
    if rss_mb() > budget_mb:
        raise MemoryBudgetError()


def is_oom(exc: BaseException) -> bool:
    if isinstance(exc, MemoryError):
        return True
    name = type(exc).__name__
    if name in {"OutOfMemoryError"}:
        return True
    text = str(exc).lower()
    return "out of memory" in text or "not enough memory" in text
