"""Process configuration. Values come from the environment; no secrets are logged."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

BackendName = Literal["cpu", "npu"]
NpuPrecision = Literal["bf16", "int8"]

DEFAULT_MODEL_ID = "convaiinnovations/laya"
# Pinned Hugging Face revision of the English root checkpoint (2026-09-20).
DEFAULT_MODEL_REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982"
ROOT_ALLOW_PATTERNS = (
    "model.safetensors",
    "rl_agent_config.json",
    "encoder/*",
    "tokenizer/*",
)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _env_int(name: str, default: int) -> int:
    raw = _env(name, str(default))
    try:
        value = int(raw, 10)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    return value


def _env_float(name: str, default: float) -> float:
    raw = _env(name, str(default))
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    return value


def _optional_path(name: str) -> Path | None:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return None
    return Path(raw)


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    backend: BackendName
    model_id: str
    model_revision: str
    model_subfolder: str | None
    cache_dir: Path
    onnx_path: Path | None
    ep_context_dir: Path
    vitisai_cache_dir: Path
    report_path: Path
    assignment_threshold: float
    max_body_bytes: int
    max_concurrency: int
    max_questions: int
    memory_budget_mb: int
    request_timeout_sec: float
    acquire_timeout_sec: float
    npu_device: Path
    npu_precision: NpuPrecision
    hf_token: str | None

    @property
    def allow_patterns(self) -> tuple[str, ...]:
        if self.model_subfolder:
            return (f"{self.model_subfolder}/*",)
        return ROOT_ALLOW_PATTERNS


def load_settings() -> Settings:
    backend_raw = _env("LAYA_BACKEND", "cpu").strip().lower()
    if backend_raw not in ("cpu", "npu"):
        raise ValueError("LAYA_BACKEND must be 'cpu' or 'npu'")
    precision_raw = _env("LAYA_NPU_PRECISION", "bf16").strip().lower()
    if precision_raw not in ("bf16", "int8"):
        raise ValueError("LAYA_NPU_PRECISION must be 'bf16' or 'int8'")
    subfolder = os.environ.get("LAYA_MODEL_SUBFOLDER") or None
    if subfolder == "":
        subfolder = None
    cache_dir = Path(_env("LAYA_CACHE_DIR", "/var/cache/laya"))
    threshold = _env_float("LAYA_NPU_ASSIGNMENT_THRESHOLD", 0.95)
    if not 0.0 < threshold <= 1.0:
        raise ValueError("LAYA_NPU_ASSIGNMENT_THRESHOLD must be in (0, 1]")
    report_path = _optional_path("XLNX_ONNX_EP_REPORT_FILE") or (
        cache_dir / "vitisai_ep_report.json"
    )
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    return Settings(
        host=_env("LAYA_HOST", "0.0.0.0"),
        port=_env_int("LAYA_PORT", 8090),
        backend=backend_raw,  # type: ignore[arg-type]
        model_id=_env("LAYA_MODEL_ID", DEFAULT_MODEL_ID),
        model_revision=_env("LAYA_MODEL_REVISION", DEFAULT_MODEL_REVISION),
        model_subfolder=subfolder,
        cache_dir=cache_dir,
        onnx_path=_optional_path("LAYA_ONNX_PATH"),
        ep_context_dir=Path(_env("LAYA_EP_CONTEXT_DIR", str(cache_dir / "ep-context"))),
        vitisai_cache_dir=Path(_env("LAYA_VITISAI_CACHE_DIR", str(cache_dir / "vaip"))),
        report_path=report_path,
        assignment_threshold=threshold,
        max_body_bytes=_env_int("LAYA_MAX_BODY_BYTES", 524288),
        max_concurrency=_env_int("LAYA_MAX_CONCURRENCY", 1),
        max_questions=_env_int("LAYA_MAX_QUESTIONS", 32),
        memory_budget_mb=_env_int("LAYA_MEMORY_BUDGET_MB", 4096),
        request_timeout_sec=_env_float("LAYA_REQUEST_TIMEOUT_SEC", 30.0),
        acquire_timeout_sec=_env_float("LAYA_ACQUIRE_TIMEOUT_SEC", 2.0),
        npu_device=Path(_env("LAYA_NPU_DEVICE", "/dev/accel/accel0")),
        npu_precision=precision_raw,  # type: ignore[arg-type]
        hf_token=token or None,
    )
