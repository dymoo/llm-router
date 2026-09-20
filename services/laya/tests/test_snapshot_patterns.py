import unittest
from fnmatch import fnmatchcase

from laya_service.config import ROOT_ALLOW_PATTERNS, Settings
from pathlib import Path


class SnapshotPatternTests(unittest.TestCase):
    def test_root_patterns_exclude_bundled_checkpoints(self) -> None:
        files = [
            "model.safetensors", "rl_agent_config.json", "tokenizer/tokenizer.json",
            "encoder/config.json", "typed-decisions/model.safetensors",
            "multilingual/model.safetensors", "typed-decisions/encoder/config.json",
        ]
        selected = [name for name in files if any(fnmatchcase(name, pattern) for pattern in ROOT_ALLOW_PATTERNS)]
        self.assertEqual(selected, files[:4])

    def test_subfolder_is_opt_in(self) -> None:
        settings = Settings(
            host="127.0.0.1",
            port=8090,
            backend="cpu",
            model_id="convaiinnovations/laya",
            model_revision="1c5edc17a7acd8701df6fc341c0d179f1c62c982",
            model_subfolder="typed-decisions",
            cache_dir=Path("/tmp/laya"),
            onnx_path=None,
            ep_context_dir=Path("/tmp/laya/ep"),
            vitisai_cache_dir=Path("/tmp/laya/vaip"),
            report_path=Path("/tmp/laya/report.json"),
            assignment_threshold=0.95,
            max_body_bytes=1024,
            max_concurrency=1,
            max_questions=8,
            memory_budget_mb=4096,
            request_timeout_sec=5.0,
            acquire_timeout_sec=1.0,
            npu_device=Path("/dev/null"),
            npu_precision="bf16",
            hf_token=None,
        )
        files = ["model.safetensors", "typed-decisions/model.safetensors", "multilingual/model.safetensors"]
        selected = [name for name in files if any(fnmatchcase(name, pattern) for pattern in settings.allow_patterns)]
        self.assertEqual(selected, ["typed-decisions/model.safetensors"])


if __name__ == "__main__":
    unittest.main()
