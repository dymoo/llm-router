"""Feed the real Agent.predict / ONNX decode shape through schema and HTTP.

Not a TypeScript fixture echo: the payload matches NandhaKishorM/laya Agent.system_one
(type, action, legend, model, usage.input_tokens) then must emerge as the public
{answers with type, usage, backend} contract.
"""

from __future__ import annotations

import json
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen

from laya_service.config import Settings
from laya_service.decode import decode_answers
from laya_service.errors import SchemaError
from laya_service.http_server import serve
from laya_service.runtime import Runtime
from laya_service.schema import validate_decide_request, validate_decide_response

QUESTIONS = {
    "task": {
        "type": "choice",
        "instructions": "What is the primary task?",
        "criteria": {"chat": "social", "coding": "software"},
    },
    "trivialChat": {
        "type": "noul",
        "instructions": "Is this purely social chat?",
    },
    "expectedLength": {
        "type": "score",
        "instructions": "Expected visible length",
        "criteria": ["short", "medium", "long"],
    },
}

# Byte-faithful to laya.agent.Agent.system_one return, minus tensors.
UPSTREAM_PREDICT = {
    "model": "laya-rl-agent",
    "answers": {
        "task": {
            "type": "choice",
            "choice": "coding",
            "probabilities": {"chat": 0.1, "coding": 0.9},
            "confidence": 0.8,
            "action": {"act_probability": 0.12},
        },
        "trivialChat": {
            "type": "noul",
            "noul": 0.02,
            "confidence": 0.98,
            "action": {"act_probability": 0.12},
        },
        "expectedLength": {
            "type": "score",
            "score": 1.2,
            "legend": {"0": "short", "1": "medium", "2": "long"},
            "probabilities": {"0": 0.2, "1": 0.6, "2": 0.2},
            "confidence": 0.4,
            "action": {"act_probability": 0.12},
        },
    },
    "usage": {"input_tokens": 37, "output_tokens": 0},
}


def _settings() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        backend="cpu",
        model_id="convaiinnovations/laya",
        model_revision="1c5edc17a7acd8701df6fc341c0d179f1c62c982",
        model_subfolder=None,
        cache_dir=Path("/tmp/laya-test-cache"),
        onnx_path=None,
        ep_context_dir=Path("/tmp/laya-test-cache/ep"),
        vitisai_cache_dir=Path("/tmp/laya-test-cache/vaip"),
        report_path=Path("/tmp/laya-test-cache/vitisai_ep_report.json"),
        assignment_threshold=0.95,
        max_body_bytes=4096,
        max_concurrency=1,
        max_questions=8,
        memory_budget_mb=4096,
        request_timeout_sec=5.0,
        acquire_timeout_sec=0.2,
        npu_device=Path("/dev/accel/accel0"),
        npu_precision="bf16",
        hf_token=None,
    )


class UpstreamBackend:
    """CPU/ONNX seam: wraps Agent.predict output the same way CpuBackend does."""

    name = "cpu"
    _cfg = {"max_len": 512, "head_max_len": 192, "encoder": "answerdotai/ModernBERT-large"}
    _tok = None

    def decide(self, state, questions):  # noqa: ANN001
        raw = UPSTREAM_PREDICT
        return validate_decide_response(
            {
                "answers": raw["answers"],
                "usage": raw["usage"],
                "backend": "cpu",
            },
            questions,
            expected_backend="cpu",
        )

    def health(self):
        return {"backend": "cpu", "provider": "upstream-shape"}


class UpstreamContractTests(unittest.TestCase):
    def test_schema_keeps_type_strips_action_legend(self) -> None:
        _, questions = validate_decide_request(
            {"state": "fix the flaky test", "questions": QUESTIONS},
            max_questions=8,
        )
        out = validate_decide_response(
            {
                "answers": UPSTREAM_PREDICT["answers"],
                "usage": UPSTREAM_PREDICT["usage"],
                "backend": "cpu",
            },
            questions,
            expected_backend="cpu",
        )
        self.assertEqual(out["usage"]["input_tokens"], 37)
        self.assertEqual(out["usage"]["output_tokens"], 0)
        self.assertEqual(out["answers"]["task"]["type"], "choice")
        self.assertEqual(out["answers"]["task"]["choice"], "coding")
        self.assertNotIn("action", out["answers"]["task"])
        self.assertEqual(out["answers"]["trivialChat"]["type"], "noul")
        self.assertEqual(out["answers"]["expectedLength"]["type"], "score")
        self.assertNotIn("legend", out["answers"]["expectedLength"])

    def test_missing_usage_is_refused_not_zeroed(self) -> None:
        _, questions = validate_decide_request(
            {"state": "x", "questions": QUESTIONS},
            max_questions=8,
        )
        with self.assertRaises(SchemaError) as ctx:
            validate_decide_response(
                {"answers": UPSTREAM_PREDICT["answers"], "backend": "cpu"},
                questions,
                expected_backend="cpu",
            )
        self.assertEqual(ctx.exception.code, "invalid_result")

    def test_onnx_decode_includes_type_and_passes_schema(self) -> None:
        answers = decode_answers(
            questions=QUESTIONS,
            question_ids=["task", "trivialChat", "expectedLength"],
            logits=[[0.0, 4.0], [4.0, -4.0], [0.0, 1.0, 0.0]],
            act_probs=[[0.9, 0.1], [0.9, 0.1], [0.9, 0.1]],
            marker_counts=[2, 2, 3],
            temperature=[1.0, 1.0, 1.0],
            temperature_by_options={},
        )
        self.assertEqual(answers["task"]["type"], "choice")
        self.assertEqual(answers["trivialChat"]["type"], "noul")
        self.assertEqual(answers["expectedLength"]["type"], "score")
        out = validate_decide_response(
            {"answers": answers, "usage": {"input_tokens": 12, "output_tokens": 0}, "backend": "npu"},
            QUESTIONS,
            expected_backend="npu",
        )
        self.assertEqual(out["answers"]["task"]["type"], "choice")

    def test_http_decide_emits_type_from_upstream_shape(self) -> None:
        runtime = Runtime(_settings(), backend=UpstreamBackend())
        server = serve(runtime)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            payload = json.dumps({"state": "fix the flaky test", "questions": QUESTIONS}).encode()
            req = Request("http://127.0.0.1:%d/v1/decide" % port, data=payload, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("Content-Length", str(len(payload)))
            with urlopen(req, timeout=2) as response:
                body = json.loads(response.read().decode("utf-8"))
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(body["backend"], "cpu")
        self.assertEqual(body["usage"]["input_tokens"], 37)
        self.assertEqual(body["answers"]["task"]["type"], "choice")
        self.assertEqual(body["answers"]["trivialChat"]["type"], "noul")
        self.assertEqual(body["answers"]["expectedLength"]["type"], "score")
        self.assertNotIn("action", body["answers"]["task"])


if __name__ == "__main__":
    unittest.main()
