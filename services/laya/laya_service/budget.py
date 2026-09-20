"""Exact Laya context budget using the loaded tokenizer.

Laya `build_sequence` silently slices state to `room`. This service rejects that
case instead of trimming. Measurement mirrors NandhaKishorM/laya laya/common.py.
"""

from __future__ import annotations

from typing import Any, Mapping

from .errors import ContextExceeded
from .schema import option_count


def measure_question(
    tok: Any,
    cfg: Mapping[str, Any],
    state: Any,
    question: Mapping[str, Any],
) -> dict[str, int | bool]:
    from laya.common import render_options, serialize_state

    max_len = int(cfg.get("max_len", 512))
    head_max_len = int(cfg.get("head_max_len", 192))
    mask_tok = tok.mask_token
    internal = {
        "t": question["type"],
        "ins": question["instructions"],
        "crit": question.get("criteria"),
    }
    opts = render_options(internal)
    ins = str(internal["ins"]).replace(mask_tok, " ")
    head_ids = tok("%s question: %s" % (internal["t"], ins), add_special_tokens=False)["input_ids"]
    opt_ids = [
        [tok.mask_token_id] + tok(" " + opt.replace(mask_tok, " "), add_special_tokens=False)["input_ids"]
        for opt in opts
    ]
    # Upstream also slices criteria to 48 tokens and the question head to its
    # own budget. Reject either loss, not just truncation of the task state.
    opt_budget = head_max_len - sum(len(option) for option in opt_ids)
    head_would_truncate = (
        any(len(option) - 1 > 48 for option in opt_ids)
        or opt_budget < 16
        or len(head_ids) > max(8, opt_budget)
    )
    prefix_len = 1 + len(head_ids) + 1 + sum(len(o) for o in opt_ids) + 1
    room = max(0, max_len - prefix_len - 1)
    state_ids = tok(serialize_state(state).replace(mask_tok, " "), add_special_tokens=False)["input_ids"]
    state_tokens = len(state_ids)
    return {
        "max_len": max_len,
        "head_max_len": head_max_len,
        "head_budget": head_max_len,
        "option_count": option_count(question),
        "head_tokens": prefix_len,
        "state_tokens": state_tokens,
        "state_budget": room,
        "head_would_truncate": head_would_truncate,
        "state_would_truncate": state_tokens > room,
        "would_truncate": head_would_truncate or state_tokens > room,
        "input_tokens": prefix_len + state_tokens + 1,
    }


def measure_request(tok: Any, cfg: Mapping[str, Any], state: Any, questions: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    per: dict[str, Any] = {}
    truncates = False
    worst_budget = int(cfg.get("max_len", 512))
    total_input = 0
    for qid, question in questions.items():
        item = measure_question(tok, cfg, state, question)
        per[qid] = item
        truncates = truncates or bool(item["would_truncate"])
        worst_budget = min(worst_budget, int(item["state_budget"]))
        total_input += int(item["input_tokens"])
    return {
        "max_len": int(cfg.get("max_len", 512)),
        "head_max_len": int(cfg.get("head_max_len", 192)),
        "head_budget": int(cfg.get("head_max_len", 192)),
        "encoder": cfg.get("encoder"),
        "questions": per,
        "worst_state_budget": worst_budget,
        "input_tokens": total_input,
        "would_truncate": truncates,
        "fits": not truncates,
    }


def reject_if_truncates(report: Mapping[str, Any]) -> None:
    if not report.get("would_truncate"):
        return
    raise ContextExceeded(
        input_tokens=int(report.get("input_tokens") or 0),
        max_len=int(report.get("max_len") or 0),
        head_budget=int(report.get("head_budget") or report.get("head_max_len") or 0),
    )


def checkpoint_facts(cfg: Mapping[str, Any]) -> dict[str, Any]:
    max_len = int(cfg.get("max_len", 512))
    head_max_len = int(cfg.get("head_max_len", 192))
    return {
        "max_len": max_len,
        "head_budget": head_max_len,
        "head_max_len": head_max_len,
        "encoder": cfg.get("encoder"),
        "state_budget_tokens_if_min_head": max(0, max_len - head_max_len - 2),
        "truncate_policy": "reject",
    }
