"""Download only the requested Laya checkpoint files at a pinned revision.

Upstream `laya.load("convaiinnovations/laya")` snapshots the whole Hub repo,
including multilingual/ and typed-decisions/. This process never does that.
"""

from __future__ import annotations

import os
from pathlib import Path

from .config import Settings


def download_checkpoint(settings: Settings) -> Path:
    from huggingface_hub import snapshot_download

    dest = snapshot_download(
        repo_id=settings.model_id,
        revision=settings.model_revision,
        cache_dir=str(settings.cache_dir / "hf"),
        allow_patterns=list(settings.allow_patterns),
        token=settings.hf_token,
    )
    root = Path(dest)
    if settings.model_subfolder:
        root = root / settings.model_subfolder
    cfg = root / "rl_agent_config.json"
    weights = root / "model.safetensors"
    if not cfg.is_file() or not weights.is_file():
        raise FileNotFoundError(
            "checkpoint is missing rl_agent_config.json or model.safetensors after root-only snapshot"
        )
    return root


def apply_runtime_env() -> None:
    """Prevent TensorFlow import deadlocks in transformers (Laya model card)."""
    os.environ.setdefault("USE_TF", "0")
    os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
    os.environ.setdefault("TRANSFORMERS_NO_FLAX", "1")
