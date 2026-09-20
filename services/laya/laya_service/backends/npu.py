"""Optional NPU backend. Never silently executes on CPU while reporting npu."""

from __future__ import annotations

from typing import Any

from ..config import Settings
from ..decode import decode_answers
from ..errors import BackendConfigError, MemoryBudgetError
from ..memory import is_oom, raise_if_over_budget, rss_mb
from ..npu.assignment import AssignmentReport, assert_npu_allowed, load_assignment_report
from ..npu.compile import vitisai_provider_options
from ..schema import validate_decide_response
from ..snapshot import apply_runtime_env, download_checkpoint


class NpuBackend:
    name = "npu"

    def __init__(self, settings: Settings) -> None:
        apply_runtime_env()
        if not settings.npu_device.exists():
            raise BackendConfigError(
                f"NPU device {settings.npu_device} is missing. Deployed default is CPU; "
                "NPU requires IOMMU enabled and a real Strix Halo accelerator."
            )
        onnx_path = settings.onnx_path
        if onnx_path is None or not onnx_path.is_file():
            raise BackendConfigError(
                "LAYA_ONNX_PATH must point at an exported DecisionModel graph for NPU mode"
            )
        import numpy as np
        import onnxruntime as ort

        providers = list(ort.get_available_providers())
        if "VitisAIExecutionProvider" not in providers:
            raise BackendConfigError(
                "VitisAIExecutionProvider is not installed; refusing NPU mode (no CPU fallback)"
            )
        context_path = settings.ep_context_dir / "laya.epctx.onnx"
        session_options = ort.SessionOptions()
        if context_path.is_file():
            session_options.add_session_config_entry("ep.context_enable", "1")
            session_options.add_session_config_entry("ep.context_file_path", str(context_path))
        session_options.add_session_config_entry("ep.context_embed_mode", "1")
        provider_options = vitisai_provider_options(
            cache_dir=settings.vitisai_cache_dir,
            cache_key="laya-decision-model",
            report_path=settings.report_path,
            precision=settings.npu_precision,
            config_file=None,
        )
        try:
            session = ort.InferenceSession(
                str(onnx_path),
                sess_options=session_options,
                providers=["VitisAIExecutionProvider"],
                provider_options=[provider_options],
            )
        except Exception as exc:
            if is_oom(exc):
                raise MemoryBudgetError("NPU session creation exceeded memory budget") from exc
            raise BackendConfigError(f"VitisAI session failed: {type(exc).__name__}") from exc
        active = list(session.get_providers())
        if active != ["VitisAIExecutionProvider"]:
            raise BackendConfigError(
                "session providers %s are not exclusive VitisAI; refusing NPU claim" % active
            )
        assignment = load_assignment_report(settings.report_path)
        assert_npu_allowed(
            providers=active,
            assignment=assignment,
            threshold=settings.assignment_threshold,
        )
        model_dir = download_checkpoint(settings)
        from transformers import AutoTokenizer

        # Tokenizer + calibration only; encoder weights stay on the ORT session.
        tok_dir = model_dir / "tokenizer"
        self._tok = AutoTokenizer.from_pretrained(str(tok_dir if tok_dir.is_dir() else model_dir))
        agent_cfg_path = model_dir / "rl_agent_config.json"
        import json

        self._cfg = json.loads(agent_cfg_path.read_text(encoding="utf-8"))
        self._session = session
        self._np = np
        self._settings = settings
        self._assignment: AssignmentReport = assignment
        self._model_dir = model_dir
        self._pad_id = int(self._tok.pad_token_id or 0)
        raise_if_over_budget(settings.memory_budget_mb)

    def decide(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        raise_if_over_budget(self._settings.memory_budget_mb)
        from laya.common import QTYPES, build_sequence, collate_items, render_options

        ids = list(questions.keys())
        items = []
        max_len = int(self._cfg.get("max_len", 512))
        head_max_len = int(self._cfg.get("head_max_len", 192))
        for qid in ids:
            internal = _to_internal(questions[qid])
            seq, markers = build_sequence(self._tok, state, internal, max_len, head_max_len)
            if len(markers) != len(render_options(internal)):
                raise ValueError("question options exceed head_max_len")
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES[internal["t"]]})
        batch = collate_items([items], self._pad_id)
        feeds = {
            "input_ids": batch["input_ids"].numpy(),
            "attention_mask": batch["attention_mask"].numpy(),
            "marker_pos": batch["marker_pos"].numpy(),
            "marker_mask": batch["marker_mask"].numpy(),
            "qtype": batch["qtype"].numpy(),
        }
        try:
            logits, act = self._session.run(["logits", "act_probs"], feeds)
        except Exception as exc:
            if is_oom(exc):
                raise MemoryBudgetError("NPU inference exceeded memory budget") from exc
            raise
        answers = decode_answers(
            questions=questions,
            question_ids=ids,
            logits=logits.tolist(),
            act_probs=act.tolist(),
            marker_counts=[len(it["markers"]) for it in items],
            temperature=self._cfg.get("temperature", [1.0, 1.0, 1.0]),
            temperature_by_options=self._cfg.get("temperature_by_options", {}),
        )
        input_tokens = int(batch["attention_mask"].sum())
        result = {
            "answers": answers,
            "usage": {"input_tokens": input_tokens, "output_tokens": 0},
            "backend": "npu",
        }
        return validate_decide_response(result, questions, expected_backend="npu")

    def health(self) -> dict[str, Any]:
        return {
            "backend": "npu",
            "provider": "VitisAIExecutionProvider",
            "device": str(self._settings.npu_device),
            "npu_nodes": self._assignment.npu_nodes,
            "cpu_nodes": self._assignment.cpu_nodes,
            "npu_fraction": self._assignment.npu_fraction,
            "unsupported": list(self._assignment.unsupported),
            "rss_mb": rss_mb(),
            "iommu": "required-enabled",
        }


def _to_internal(qdef: dict[str, Any]) -> dict[str, Any]:
    import json

    t = qdef["type"]
    crit = qdef.get("criteria")
    if t == "choice" and isinstance(crit, list):
        crit = {c: None for c in crit}
    ins = qdef["instructions"]
    if not isinstance(ins, str):
        ins = json.dumps(ins)
    return {"t": t, "ins": ins, "crit": crit}
