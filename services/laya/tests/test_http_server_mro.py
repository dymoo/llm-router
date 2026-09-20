"""Regression: ThreadingHTTPServer already includes ThreadingMixIn; dual inherit breaks MRO."""

from __future__ import annotations

import json
import threading
import unittest
from pathlib import Path
from urllib.request import urlopen

from laya_service.config import Settings
from laya_service.http_server import serve
from laya_service.runtime import Runtime


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


class _HealthBackend:
    name = "cpu"
    _cfg = {"max_len": 512, "head_max_len": 192, "encoder": "answerdotai/ModernBERT-large"}
    _tok = None

    def decide(self, state, questions):  # noqa: ANN001
        raise AssertionError("decide is not part of this seam")

    def health(self):
        return {"backend": "cpu", "provider": "import-seam"}


class HttpServerMroTests(unittest.TestCase):
    def test_import_and_bind_serves_healthz(self) -> None:
        runtime = Runtime(_settings(), backend=_HealthBackend())
        server = serve(runtime)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen("http://127.0.0.1:%d/healthz" % port, timeout=2) as response:
                body = json.loads(response.read().decode("utf-8"))
            self.assertEqual(body["backend"], "cpu")
            self.assertTrue(body["ready"])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
