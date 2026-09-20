import json
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from laya_service.config import Settings
from laya_service.http_server import serve
from laya_service.runtime import Runtime


def _settings(**overrides: object) -> Settings:
    values = dict(
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
        max_body_bytes=256,
        max_concurrency=1,
        max_questions=8,
        memory_budget_mb=4096,
        request_timeout_sec=5.0,
        acquire_timeout_sec=0.2,
        npu_device=Path("/dev/accel/accel0"),
        npu_precision="bf16",
        hf_token=None,
    )
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


class FakeBackend:
    name = "cpu"
    _cfg = {
        "max_len": 512,
        "head_max_len": 192,
        "encoder": "answerdotai/ModernBERT-large",
    }
    _tok = None

    def decide(self, state, questions):  # noqa: ANN001
        answers = {}
        for qid, question in questions.items():
            if question["type"] == "choice":
                labels = list(question["criteria"])
                answers[qid] = {
                    "type": "choice",
                    "choice": labels[0],
                    "probabilities": {label: (1.0 if i == 0 else 0.0) for i, label in enumerate(labels)},
                    "confidence": 1.0,
                }
            elif question["type"] == "score":
                k = len(question["criteria"])
                answers[qid] = {
                    "type": "score",
                    "score": 0.0,
                    "probabilities": {str(i): (1.0 if i == 0 else 0.0) for i in range(k)},
                    "confidence": 1.0,
                }
            else:
                answers[qid] = {"type": "noul", "noul": 0.1}
        return {"answers": answers, "usage": {"input_tokens": 4, "output_tokens": 0}, "backend": "cpu"}

    def health(self):
        return {"backend": "cpu", "provider": "fake"}


class HttpBoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = Runtime(_settings(), backend=FakeBackend())
        self.server = serve(self.runtime)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def _url(self, path: str) -> str:
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def test_healthz_exposes_revision_and_budget(self) -> None:
        with urlopen(self._url("/healthz")) as response:
            body = json.loads(response.read().decode("utf-8"))
        self.assertTrue(body["ok"])
        self.assertTrue(body["ready"])
        self.assertEqual(body["backend"], "cpu")
        self.assertEqual(body["model_revision"], "1c5edc17a7acd8701df6fc341c0d179f1c62c982")
        self.assertEqual(body["max_len"], 512)
        self.assertEqual(body["head_budget"], 192)

    def test_rejects_oversized_body(self) -> None:
        payload = json.dumps({"state": "x" * 200, "questions": {"q": {"type": "noul", "instructions": "y"}}}).encode()
        req = Request(self._url("/v1/decide"), data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Content-Length", str(len(payload)))
        with self.assertRaises(HTTPError) as ctx:
            urlopen(req)
        self.assertEqual(ctx.exception.code, 413)
        err = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(err["error"]["code"], "payload_too_large")

    def test_decide_valid_small_body(self) -> None:
        payload = json.dumps(
            {
                "state": "hi",
                "questions": {
                    "q": {"type": "noul", "instructions": "social?"},
                },
            }
        ).encode()
        req = Request(self._url("/v1/decide"), data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Content-Length", str(len(payload)))
        with urlopen(req) as response:
            body = json.loads(response.read().decode("utf-8"))
        self.assertEqual(body["backend"], "cpu")
        self.assertEqual(body["usage"]["output_tokens"], 0)
        self.assertIn("q", body["answers"])


if __name__ == "__main__":
    unittest.main()
