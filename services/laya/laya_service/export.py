"""Export the complete Laya DecisionModel (encoder + decision head) to one ONNX graph.

Reproducible:

  USE_TF=0 python -m laya_service export \\
    --out /var/cache/laya/onnx \\
    --model convaiinnovations/laya \\
    --revision 1c5edc17a7acd8701df6fc341c0d179f1c62c982

Inputs : input_ids[B,L] int64, attention_mask[B,L] int64,
         marker_pos[B,K] int64, marker_mask[B,K] bool, qtype[B] int64
Outputs: logits[B,K] float32, act_probs[B,2] float32

Grad stays enabled during export: TransformerEncoderLayer's fused fast path is
not ONNX-exportable and is only taken under no_grad (receptron/laya note).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from .config import DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION, Settings, load_settings
from .snapshot import apply_runtime_env, download_checkpoint


class _Wrapper:
    def __init__(self, model):  # noqa: ANN001
        import torch

        self.torch = torch
        self.model = model

    def __call__(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):  # noqa: ANN001
        logits, act = self.model(input_ids, attention_mask, marker_pos, marker_mask, qtype)
        return logits, self.torch.softmax(act.float(), -1)


def export_onnx(settings: Settings, out_dir: Path) -> dict:
    apply_runtime_env()
    import numpy as np
    import torch
    from laya.agent import Agent

    out_dir.mkdir(parents=True, exist_ok=True)
    model_dir = download_checkpoint(settings)
    agent = Agent(str(model_dir), device="cpu")
    agent.model.eval()
    try:
        agent.model.encoder.config.reference_compile = False
    except Exception:
        pass
    wrapper = _Wrapper(agent.model)
    batch, seq, opts = 2, 40, 4
    example = (
        torch.randint(5, 1000, (batch, seq)),
        torch.ones(batch, seq, dtype=torch.long),
        torch.tensor([[3, 9, 15, 21], [3, 9, 0, 0]]),
        torch.tensor([[True, True, True, True], [True, True, False, False]]),
        torch.tensor([0, 2]),
    )
    example[1][1, 30:] = 0
    onnx_path = out_dir / "laya.onnx"
    dim_b = torch.export.Dim("batch")
    dim_s = torch.export.Dim("seq", min=8)
    dim_k = torch.export.Dim("options", min=2)
    program = torch.onnx.export(
        wrapper,
        example,
        opset_version=17,
        dynamo=True,
        optimize=True,
        input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
        output_names=["logits", "act_probs"],
        dynamic_shapes={
            "input_ids": {0: dim_b, 1: dim_s},
            "attention_mask": {0: dim_b, 1: dim_s},
            "marker_pos": {0: dim_b, 1: dim_k},
            "marker_mask": {0: dim_b, 1: dim_k},
            "qtype": {0: dim_b},
        },
    )
    program.save(str(onnx_path), external_data=False)
    tok_src = model_dir / "tokenizer"
    if tok_src.is_dir():
        shutil.copytree(tok_src, out_dir / "tokenizer", dirs_exist_ok=True)
    cfg = {
        k: agent.cfg[k]
        for k in ("encoder", "max_len", "head_max_len", "temperature", "temperature_by_options")
        if k in agent.cfg
    }
    cfg["model_id"] = settings.model_id
    cfg["model_revision"] = settings.model_revision
    (out_dir / "laya_config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    with torch.enable_grad():
        ref_logits, ref_act = wrapper(*example)
    got = session.run(
        None,
        {
            "input_ids": example[0].numpy(),
            "attention_mask": example[1].numpy(),
            "marker_pos": example[2].numpy(),
            "marker_mask": example[3].numpy(),
            "qtype": example[4].numpy(),
        },
    )
    dlogits = float(np.abs(got[0] - ref_logits.detach().numpy()).max())
    dact = float(np.abs(got[1] - ref_act.detach().numpy()).max())
    return {
        "onnx_path": str(onnx_path),
        "max_len": cfg.get("max_len"),
        "head_max_len": cfg.get("head_max_len"),
        "max_abs_logits_delta": dlogits,
        "max_abs_act_delta": dact,
        "model_revision": settings.model_revision,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export Laya DecisionModel to ONNX")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL_ID)
    parser.add_argument("--revision", default=DEFAULT_MODEL_REVISION)
    parser.add_argument("--subfolder", default=None)
    args = parser.parse_args(argv)
    settings = load_settings()
    object.__setattr__(settings, "model_id", args.model)
    object.__setattr__(settings, "model_revision", args.revision)
    object.__setattr__(settings, "model_subfolder", args.subfolder)
    result = export_onnx(settings, args.out)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
