import unittest

from laya_service.errors import SchemaError
from laya_service.schema import validate_decide_request, validate_decide_response


def _questions() -> dict:
    return {
        "task": {
            "type": "choice",
            "instructions": "What is the primary task?",
            "criteria": {
                "chat": "social conversation",
                "coding": "software work",
                "math": "mathematics",
                "analysis": "analysis",
                "writing": "writing",
                "extraction": "extraction",
            },
        },
        "difficulty": {
            "type": "choice",
            "instructions": "How hard is this?",
            "criteria": {"easy": None, "moderate": None, "hard": None},
        },
        "effort": {
            "type": "choice",
            "instructions": "Reasoning effort?",
            "criteria": {"low": None, "medium": None, "high": None, "xhigh": None},
        },
        "trivialChat": {
            "type": "noul",
            "instructions": "Is this purely social chat?",
        },
        "localSufficiency": {
            "type": "noul",
            "instructions": "Can the weakest local model handle this?",
        },
        "freshFacts": {
            "type": "noul",
            "instructions": "Are missing fresh facts required?",
        },
        "expectedLength": {
            "type": "score",
            "instructions": "Expected visible length",
            "criteria": ["short", "medium", "long"],
        },
    }


class SchemaTests(unittest.TestCase):
    def test_accepts_router_questions(self) -> None:
        state, questions = validate_decide_request(
            {"state": {"brief": "fix the flaky test"}, "questions": _questions()},
            max_questions=32,
        )
        self.assertEqual(state["brief"], "fix the flaky test")
        self.assertEqual(len(questions), 7)
        self.assertEqual(questions["expectedLength"]["type"], "score")

    def test_rejects_unknown_type(self) -> None:
        with self.assertRaises(SchemaError):
            validate_decide_request(
                {
                    "state": "x",
                    "questions": {
                        "q": {"type": "bool", "instructions": "yes?"},
                    },
                },
                max_questions=8,
            )

    def test_rejects_single_choice_option(self) -> None:
        with self.assertRaises(SchemaError):
            validate_decide_request(
                {
                    "state": "x",
                    "questions": {
                        "q": {
                            "type": "choice",
                            "instructions": "only one",
                            "criteria": {"a": None},
                        }
                    },
                },
                max_questions=8,
            )

    def test_rejects_empty_questions(self) -> None:
        with self.assertRaises(SchemaError):
            validate_decide_request({"state": "x", "questions": {}}, max_questions=8)

    def test_rejects_non_zero_output_tokens(self) -> None:
        questions = {
            "q": {
                "type": "noul",
                "instructions": "yes?",
                "criteria": None,
            }
        }
        state, validated = validate_decide_request(
            {"state": "hello", "questions": questions},
            max_questions=8,
        )
        with self.assertRaises(SchemaError):
            validate_decide_response(
                {
                    "answers": {"q": {"noul": 0.2}},
                    "usage": {"input_tokens": 3, "output_tokens": 4},
                    "backend": "cpu",
                },
                validated,
                expected_backend="cpu",
            )

    def test_choice_answer_must_use_criteria_label(self) -> None:
        _, validated = validate_decide_request(
            {
                "state": "x",
                "questions": {
                    "task": {
                        "type": "choice",
                        "instructions": "task",
                        "criteria": {"chat": None, "coding": None},
                    }
                },
            },
            max_questions=8,
        )
        with self.assertRaises(SchemaError):
            validate_decide_response(
                {
                    "answers": {
                        "task": {
                            "choice": "math",
                            "probabilities": {"chat": 0.5, "coding": 0.5},
                            "confidence": 0.1,
                        }
                    },
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                    "backend": "cpu",
                },
                validated,
                expected_backend="cpu",
            )

    def test_backend_mismatch_is_invalid_result(self) -> None:
        _, validated = validate_decide_request(
            {
                "state": "x",
                "questions": {
                    "q": {"type": "noul", "instructions": "yes?"},
                },
            },
            max_questions=8,
        )
        with self.assertRaises(SchemaError):
            validate_decide_response(
                {
                    "answers": {"q": {"noul": 0.1}},
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                    "backend": "npu",
                },
                validated,
                expected_backend="cpu",
            )


if __name__ == "__main__":
    unittest.main()
