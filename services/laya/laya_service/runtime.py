"""One loaded backend, bounded concurrency, OOM-visible health."""

from __future__ import annotations

import threading
import time
from typing import Any

from .backends.cpu import CpuBackend
from .budget import checkpoint_facts, measure_request, reject_if_truncates
from .config import Settings
from .errors import BackendConfigError, MemoryBudgetError
from .memory import apply_memory_budget, rss_mb
from .schema import validate_decide_request


class Runtime:
    def __init__(self, settings: Settings, backend: Any | None = None) -> None:
        self.settings = settings
        self.started_at = time.time()
        self.oom = False
        self.ready = False
        self.load_error: str | None = None
        self._sema = threading.BoundedSemaphore(settings.max_concurrency)
        self._in_flight = 0
        self._lock = threading.Lock()
        apply_memory_budget(settings.memory_budget_mb)
        if backend is not None:
            self.backend = backend
            self.ready = True
            return
        try:
            self.backend = self._load_backend(settings)
            self.ready = True
        except MemoryBudgetError:
            self.oom = True
            self.ready = False
            self.load_error = "oom"
            raise
        except BackendConfigError as exc:
            self.ready = False
            self.load_error = exc.code
            raise

    @staticmethod
    def _load_backend(settings: Settings) -> Any:
        if settings.backend == "cpu":
            return CpuBackend(settings)
        if settings.backend == "npu":
            from .backends.npu import NpuBackend

            return NpuBackend(settings)
        raise BackendConfigError("LAYA_BACKEND must be cpu or npu")

    def acquire(self) -> bool:
        ok = self._sema.acquire(timeout=self.settings.acquire_timeout_sec)
        if ok:
            with self._lock:
                self._in_flight += 1
        return ok

    def release(self) -> None:
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
        self._sema.release()

    def mark_oom(self) -> None:
        self.oom = True
        self.ready = False

    def decide(self, payload: Any) -> dict[str, Any]:
        if self.oom:
            raise MemoryBudgetError()
        if not self.ready:
            raise BackendConfigError(self.load_error or "backend not ready")
        state, questions = validate_decide_request(payload, max_questions=self.settings.max_questions)
        tok = getattr(self.backend, "_tok", None) or getattr(getattr(self.backend, "_agent", None), "tok", None)
        cfg = getattr(self.backend, "_cfg", None) or getattr(getattr(self.backend, "_agent", None), "cfg", None)
        if tok is not None and cfg is not None:
            report = measure_request(tok, cfg, state, questions)
            reject_if_truncates(report)
        try:
            return self.backend.decide(state, questions)
        except MemoryBudgetError:
            self.mark_oom()
            raise

    def budget(self, payload: Any) -> dict[str, Any]:
        if not self.ready:
            raise BackendConfigError(self.load_error or "backend not ready")
        state, questions = validate_decide_request(payload, max_questions=self.settings.max_questions)
        tok = getattr(self.backend, "_tok", None) or getattr(getattr(self.backend, "_agent", None), "tok", None)
        cfg = getattr(self.backend, "_cfg", None) or getattr(getattr(self.backend, "_agent", None), "cfg", None)
        if tok is None or cfg is None:
            raise BackendConfigError("tokenizer is not loaded")
        return measure_request(tok, cfg, state, questions)

    def health(self) -> dict[str, Any]:
        cfg = getattr(self.backend, "_cfg", None) or getattr(getattr(self.backend, "_agent", None), "cfg", {}) if self.ready else {}
        facts = checkpoint_facts(cfg or {})
        backend_health = self.backend.health() if self.ready else {"backend": self.settings.backend}
        with self._lock:
            in_flight = self._in_flight
        body = {
            "ok": not self.oom,
            "ready": self.ready and not self.oom,
            "backend": self.settings.backend,
            "requested_backend": self.settings.backend,
            "model_id": self.settings.model_id,
            "model_revision": self.settings.model_revision,
            "model_subfolder": self.settings.model_subfolder,
            "max_len": facts.get("max_len"),
            "head_budget": facts.get("head_budget"),
            "head_max_len": facts.get("head_max_len"),
            "one_model": True,
            "rss_mb": rss_mb(),
            "memory_budget_mb": self.settings.memory_budget_mb,
            "oom": self.oom,
            "load_error": self.load_error,
            "uptime_s": int(time.time() - self.started_at),
            "concurrency": {
                "max": self.settings.max_concurrency,
                "in_flight": in_flight,
            },
            "context": facts,
            "npu": {
                "enabled": self.settings.backend == "npu",
                "iommu_required": True,
                "note": "deployed default is CPU; NPU is incompatible with amd_iommu=off Halogen",
            },
        }
        body.update({k: v for k, v in backend_health.items() if k not in body})
        return body
