"""Structured logs that never include prompts, answers, or credentials."""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

_FORBIDDEN = frozenset(
    {
        "state",
        "questions",
        "answers",
        "prompt",
        "body",
        "token",
        "authorization",
        "criteria",
        "instructions",
    }
)


class PromptFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if any(key in record.__dict__ for key in _FORBIDDEN):
            return False
        msg = record.getMessage().lower()
        if "authorization" in msg or "bearer " in msg:
            return False
        return True


def configure_logging() -> logging.Logger:
    logger = logging.getLogger("laya_service")
    if logger.handlers:
        return logger
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.addFilter(PromptFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


def log_event(logger: logging.Logger, **fields: Any) -> None:
    safe = {k: v for k, v in fields.items() if k.lower() not in _FORBIDDEN}
    logger.info(json.dumps(safe, separators=(",", ":"), default=str))
