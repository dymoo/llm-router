"""Calibrated decode matching NandhaKishorM/laya Agent.system_one."""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

QTYPES = {"choice": 0, "score": 1, "noul": 2}
QTYPE_NAMES = {0: "choice", 1: "score", 2: "noul"}


def temp_bucket(qtype: int, k: int) -> str:
    size = "2" if k <= 2 else "3-5" if k <= 5 else "6-10" if k <= 10 else "11+"
    return "%s:%s" % (QTYPE_NAMES[int(qtype)], size)


def confidence_from_probs(p: Sequence[float], k: int) -> float:
    if k < 2:
        return 1.0
    clipped = [min(1.0, max(1e-12, float(x))) for x in p[:k]]
    ent = -sum(x * math.log(x) for x in clipped)
    return float(min(1.0, max(0.0, 1.0 - ent / math.log(k))))


def softmax(logits: Sequence[float]) -> list[float]:
    peak = max(logits)
    exps = [math.exp(z - peak) for z in logits]
    total = sum(exps) or 1.0
    return [e / total for e in exps]


def decode_answers(
    *,
    questions: Mapping[str, Mapping[str, Any]],
    question_ids: Sequence[str],
    logits: Sequence[Sequence[float]],
    act_probs: Sequence[Sequence[float]],
    marker_counts: Sequence[int],
    temperature: Sequence[float],
    temperature_by_options: Mapping[str, float],
) -> dict[str, dict[str, Any]]:
    answers: dict[str, dict[str, Any]] = {}
    for row, qid in enumerate(question_ids):
        question = questions[qid]
        k = int(marker_counts[row])
        qt = QTYPES[question["type"]]
        scale = float(temperature_by_options.get(temp_bucket(qt, k), temperature[qt]))
        z = [float(logits[row][i]) / max(1e-3, scale) for i in range(k)]
        p = softmax(z)
        conf = round(confidence_from_probs(p, k), 4)
        if question["type"] == "choice":
            keys = list(question["criteria"].keys())
            answers[qid] = {
                "type": "choice",
                "choice": keys[max(range(k), key=lambda i: p[i])],
                "probabilities": {key: round(p[i], 4) for i, key in enumerate(keys)},
                "confidence": conf,
            }
        elif question["type"] == "score":
            expected = sum(i * p[i] for i in range(k))
            answers[qid] = {
                "type": "score",
                "score": round(expected, 4),
                "probabilities": {str(i): round(p[i], 4) for i in range(k)},
                "confidence": conf,
            }
        else:
            answers[qid] = {
                "type": "noul",
                "noul": round(float(p[1]), 4),
                "confidence": round(max(float(p[1]), 1.0 - float(p[1])), 4),
            }
        _ = act_probs  # act head is not part of the public /v1/decide contract
    return answers
