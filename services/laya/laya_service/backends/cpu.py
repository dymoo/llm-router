"""CPU PyTorch backend. Loads one Laya DecisionModel and never claims NPU."""

from __future__ import annotations

from typing import Any

from ..config import Settings
from ..errors import MemoryBudgetError, SchemaError
from ..memory import is_oom, raise_if_over_budget, rss_mb
from ..schema import option_count, validate_decide_response
from ..snapshot import apply_runtime_env, download_checkpoint


class CpuBackend:
    name = "cpu"

    def __init__(self, settings: Settings) -> None:
        apply_runtime_env()
        raise_if_over_budget(settings.memory_budget_mb)
        model_dir = download_checkpoint(settings)
        try:
            from laya.agent import Agent
        except ImportError as exc:
            raise RuntimeError("laya package is required for the CPU backend") from exc
        try:
            self._agent = Agent(str(model_dir), device="cpu", token=settings.hf_token)
        except Exception as exc:
            if is_oom(exc):
                raise MemoryBudgetError("CPU model load exceeded memory budget") from exc
            raise
        if str(self._agent.device) != "cpu":
            raise RuntimeError("CPU backend refused a non-cpu torch device")
        self._settings = settings
        self._model_dir = model_dir
        self._cfg = self._agent.cfg
        self._tok = self._agent.tok
        raise_if_over_budget(settings.memory_budget_mb)

    def decide(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        raise_if_over_budget(self._settings.memory_budget_mb)
        for qid, question in questions.items():
            if option_count(question) < 2:
                raise SchemaError(f"question {qid!r} needs at least two options")
        try:
            raw = self._agent.predict(state, questions)
        except Exception as exc:
            if is_oom(exc):
                raise MemoryBudgetError("CPU inference exceeded memory budget") from exc
            raise
        if not isinstance(raw, dict):
            raise SchemaError("classifier result must be an object", code="invalid_result")
        usage = raw.get("usage")
        input_tokens = usage.get("input_tokens") if isinstance(usage, dict) else None
        if not isinstance(input_tokens, int) or isinstance(input_tokens, bool) or input_tokens < 0:
            raise SchemaError("classifier omitted usage.input_tokens", code="invalid_result")
        result = {
            "answers": raw.get("answers") if isinstance(raw, dict) else {},
            "usage": {"input_tokens": input_tokens, "output_tokens": 0},
            "backend": "cpu",
        }
        return validate_decide_response(result, questions, expected_backend="cpu")

    def health(self) -> dict[str, Any]:
        return {
            "backend": "cpu",
            "provider": "pytorch",
            "device": "cpu",
            "model_dir": str(self._model_dir),
            "rss_mb": rss_mb(),
        }
