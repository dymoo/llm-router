"""Strict request/response validation for POST /v1/decide.

Never logs state, questions, or answers.
"""

from __future__ import annotations

from typing import Any, Mapping

from .errors import SchemaError

ALLOWED_TYPES = frozenset({"choice", "score", "noul"})
QUESTION_KEYS = frozenset({"type", "instructions", "criteria"})
MAX_QUESTION_ID = 128
MAX_INSTRUCTIONS = 8000
MAX_CRITERIA = 32
MIN_CRITERIA = 2


def validate_decide_request(payload: Any, *, max_questions: int) -> tuple[Any, dict[str, dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise SchemaError("body must be a JSON object")
    if "state" not in payload or "questions" not in payload:
        raise SchemaError("body must contain 'state' and 'questions'")
    state = payload["state"]
    if not isinstance(state, (str, dict, list)):
        raise SchemaError("state must be a string, object, or array")
    questions = payload["questions"]
    if not isinstance(questions, dict) or not questions:
        raise SchemaError("questions must be a non-empty object")
    if len(questions) > max_questions:
        raise SchemaError(f"at most {max_questions} questions per request")
    validated: dict[str, dict[str, Any]] = {}
    for qid, raw in questions.items():
        if not isinstance(qid, str) or not qid or len(qid) > MAX_QUESTION_ID:
            raise SchemaError("question ids must be non-empty strings")
        validated[qid] = _validate_question(qid, raw)
    return state, validated


def _validate_question(qid: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SchemaError(f"question {qid!r} must be an object")
    extra = set(raw) - QUESTION_KEYS
    if extra:
        raise SchemaError(f"question {qid!r} has unsupported fields")
    qtype = raw.get("type")
    if qtype not in ALLOWED_TYPES:
        raise SchemaError(f"question {qid!r} type must be choice, score, or noul")
    instructions = raw.get("instructions")
    if not isinstance(instructions, str) or not instructions.strip():
        raise SchemaError(f"question {qid!r} instructions must be a non-empty string")
    if len(instructions) > MAX_INSTRUCTIONS:
        raise SchemaError(f"question {qid!r} instructions exceed {MAX_INSTRUCTIONS} characters")
    criteria = raw.get("criteria")
    if qtype == "choice":
        criteria = _choice_criteria(qid, criteria)
    elif qtype == "score":
        criteria = _score_criteria(qid, criteria)
    else:
        criteria = _noul_criteria(qid, criteria)
    return {"type": qtype, "instructions": instructions, "criteria": criteria}


def _choice_criteria(qid: str, criteria: Any) -> dict[str, Any]:
    if isinstance(criteria, list):
        if len(criteria) < MIN_CRITERIA or len(criteria) > MAX_CRITERIA:
            raise SchemaError(f"question {qid!r} choice criteria must have 2 to {MAX_CRITERIA} options")
        out: dict[str, Any] = {}
        for item in criteria:
            if not isinstance(item, str) or not item:
                raise SchemaError(f"question {qid!r} choice list entries must be non-empty strings")
            if item in out:
                raise SchemaError(f"question {qid!r} choice labels must be unique")
            out[item] = None
        return out
    if not isinstance(criteria, dict) or len(criteria) < MIN_CRITERIA or len(criteria) > MAX_CRITERIA:
        raise SchemaError(f"question {qid!r} choice criteria must be an object with 2 to {MAX_CRITERIA} labels")
    out = {}
    for key, value in criteria.items():
        if not isinstance(key, str) or not key:
            raise SchemaError(f"question {qid!r} choice labels must be non-empty strings")
        if value is not None and not isinstance(value, (str, int, float, bool, dict, list)):
            raise SchemaError(f"question {qid!r} choice rubric is not JSON-serializable")
        out[key] = value
    return out


def _score_criteria(qid: str, criteria: Any) -> list[Any]:
    if not isinstance(criteria, list) or len(criteria) < MIN_CRITERIA or len(criteria) > MAX_CRITERIA:
        raise SchemaError(f"question {qid!r} score criteria must be an array of 2 to {MAX_CRITERIA} levels")
    for item in criteria:
        if item is None:
            raise SchemaError(f"question {qid!r} score levels cannot be null")
    return list(criteria)


def _noul_criteria(qid: str, criteria: Any) -> dict[str, Any] | None:
    if criteria is None:
        return None
    if not isinstance(criteria, dict):
        raise SchemaError(f"question {qid!r} noul criteria must be an object when present")
    extra = set(criteria) - {"true", "false"}
    if extra:
        raise SchemaError(f"question {qid!r} noul criteria only allows true/false keys")
    return dict(criteria)


def option_count(question: Mapping[str, Any]) -> int:
    qtype = question["type"]
    if qtype == "choice":
        return len(question["criteria"])
    if qtype == "score":
        return len(question["criteria"])
    return 2


def validate_decide_response(
    result: Any,
    questions: Mapping[str, Mapping[str, Any]],
    *,
    expected_backend: str,
) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise SchemaError("classifier result must be an object", code="invalid_result")
    answers = result.get("answers")
    usage = result.get("usage")
    backend = result.get("backend")
    if backend != expected_backend:
        raise SchemaError("backend field does not match the loaded runtime", code="invalid_result")
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise SchemaError("answers must cover exactly the requested question ids", code="invalid_result")
    if not isinstance(usage, dict):
        raise SchemaError("usage must be an object", code="invalid_result")
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if not isinstance(input_tokens, int) or isinstance(input_tokens, bool) or input_tokens < 0:
        raise SchemaError("usage.input_tokens must be a non-negative integer", code="invalid_result")
    if output_tokens != 0:
        raise SchemaError("usage.output_tokens must be 0", code="invalid_result")
    cleaned: dict[str, Any] = {}
    for qid, question in questions.items():
        cleaned[qid] = _validate_answer(qid, question, answers[qid])
    extra = set(result) - {"answers", "usage", "backend"}
    if extra:
        # Permit unused model metadata internally; strip it from the wire body.
        pass
    return {
        "answers": cleaned,
        "usage": {"input_tokens": input_tokens, "output_tokens": 0},
        "backend": expected_backend,
    }


def _unit_interval(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0.0 <= float(value) <= 1.0


def _validate_answer(qid: str, question: Mapping[str, Any], raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SchemaError(f"answer {qid!r} must be an object", code="invalid_result")
    qtype = question["type"]
    raw_type = raw.get("type")
    if raw_type is not None and raw_type != qtype:
        raise SchemaError(f"answer {qid!r} type does not match the question", code="invalid_result")
    if qtype == "choice":
        labels = list(question["criteria"].keys())
        choice = raw.get("choice")
        probs = raw.get("probabilities")
        conf = raw.get("confidence")
        if choice not in labels:
            raise SchemaError(f"answer {qid!r} choice is not in criteria", code="invalid_result")
        if not isinstance(probs, dict) or set(probs) != set(labels):
            raise SchemaError(f"answer {qid!r} probabilities must cover every label", code="invalid_result")
        if not all(_unit_interval(v) for v in probs.values()):
            raise SchemaError(f"answer {qid!r} probabilities must be in [0, 1]", code="invalid_result")
        if not _unit_interval(conf):
            raise SchemaError(f"answer {qid!r} confidence must be in [0, 1]", code="invalid_result")
        return {
            "type": "choice",
            "choice": choice,
            "probabilities": {k: float(probs[k]) for k in labels},
            "confidence": float(conf),
        }
    if qtype == "score":
        k = len(question["criteria"])
        keys = [str(i) for i in range(k)]
        score = raw.get("score")
        probs = raw.get("probabilities")
        conf = raw.get("confidence")
        if not isinstance(score, (int, float)) or isinstance(score, bool):
            raise SchemaError(f"answer {qid!r} score must be a number", code="invalid_result")
        if not 0.0 <= float(score) <= float(k - 1):
            raise SchemaError(f"answer {qid!r} score is outside the rubric range", code="invalid_result")
        if not isinstance(probs, dict) or set(probs) != set(keys):
            raise SchemaError(f"answer {qid!r} probabilities must be keyed 0..k-1", code="invalid_result")
        if not all(_unit_interval(v) for v in probs.values()):
            raise SchemaError(f"answer {qid!r} probabilities must be in [0, 1]", code="invalid_result")
        if not _unit_interval(conf):
            raise SchemaError(f"answer {qid!r} confidence must be in [0, 1]", code="invalid_result")
        return {
            "type": "score",
            "score": float(score),
            "probabilities": {k: float(probs[k]) for k in keys},
            "confidence": float(conf),
        }
    noul = raw.get("noul")
    if not _unit_interval(noul):
        raise SchemaError(f"answer {qid!r} noul must be in [0, 1]", code="invalid_result")
    out: dict[str, Any] = {"type": "noul", "noul": float(noul)}
    if "confidence" in raw:
        if not _unit_interval(raw["confidence"]):
            raise SchemaError(f"answer {qid!r} confidence must be in [0, 1]", code="invalid_result")
        out["confidence"] = float(raw["confidence"])
    return out
