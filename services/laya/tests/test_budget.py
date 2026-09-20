import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from laya_service.budget import measure_request, reject_if_truncates
from laya_service.errors import ContextExceeded


class Tokenizer:
    mask_token = "[MASK]"
    mask_token_id = 1

    def __call__(self, text, **_kwargs):
        return {"input_ids": list(range(len(text.split())))}


def options(question):
    return list(question["crit"].values())


class BudgetTests(unittest.TestCase):
    def measure(self, state, instructions="choose", criteria=None, max_len=512, head=192):
        common = SimpleNamespace(render_options=options, serialize_state=lambda value: value if isinstance(value, str) else json.dumps(value))
        question = {"type": "choice", "instructions": instructions, "criteria": criteria or {"yes": "yes", "no": "no"}}
        with patch.dict("sys.modules", {"laya.common": common}):
            return measure_request(Tokenizer(), {"max_len": max_len, "head_max_len": head}, state, {"task": question})

    def test_rejects_criterion_truncation_even_when_total_context_fits(self):
        report = self.measure("short task", criteria={"long": "word " * 49, "short": "no"})
        self.assertFalse(report["fits"])
        self.assertTrue(report["questions"]["task"]["head_would_truncate"])
        with self.assertRaises(ContextExceeded):
            reject_if_truncates(report)

    def test_rejects_question_head_truncation(self):
        report = self.measure("short task", instructions="word " * 190)
        self.assertFalse(report["fits"])
        with self.assertRaises(ContextExceeded):
            reject_if_truncates(report)

    def test_exact_state_boundary_fits_but_one_more_token_does_not(self):
        initial = self.measure("short")
        room = initial["questions"]["task"]["state_budget"]
        self.assertTrue(self.measure("word " * room)["fits"])
        self.assertFalse(self.measure("word " * (room + 1))["fits"])


if __name__ == "__main__":
    unittest.main()
