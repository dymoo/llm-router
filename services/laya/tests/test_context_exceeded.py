import unittest

from laya_service.budget import reject_if_truncates
from laya_service.errors import ContextExceeded


class ContextExceededTests(unittest.TestCase):
    def test_overflow_is_413_context_exceeded(self) -> None:
        with self.assertRaises(ContextExceeded) as ctx:
            reject_if_truncates(
                {
                    "would_truncate": True,
                    "input_tokens": 900,
                    "max_len": 512,
                    "head_budget": 192,
                    "questions": {"task": {"would_truncate": True}},
                }
            )
        err = ctx.exception
        self.assertEqual(err.http_status, 413)
        self.assertEqual(err.code, "context_exceeded")
        self.assertEqual(err.extra["input_tokens"], 900)
        self.assertEqual(err.extra["max_len"], 512)
        self.assertEqual(err.extra["head_budget"], 192)
        self.assertNotIn("state", err.extra)
        self.assertNotIn("questions", err.message.lower() or "")


if __name__ == "__main__":
    unittest.main()
