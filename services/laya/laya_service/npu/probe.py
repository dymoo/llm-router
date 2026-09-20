"""Static operator probe. Does not claim NPU without a VitisAI assignment report."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from .operators import LAYA_BF16_GAPS, supported_ops


def probe_onnx(onnx_path: Path, precision: str) -> dict[str, Any]:
    import onnx

    model = onnx.load(str(onnx_path), load_external_data=False)
    counts: Counter[str] = Counter()
    for node in model.graph.node:
        counts[node.op_type] += 1
    allowed = supported_ops(precision)
    unsupported = sorted(op for op in counts if op not in allowed)
    return {
        "onnx_path": str(onnx_path),
        "precision": precision,
        "op_counts": dict(sorted(counts.items())),
        "unsupported_ops": unsupported,
        "unsupported_node_count": sum(counts[op] for op in unsupported),
        "total_nodes": sum(counts.values()),
        "laya_bf16_gaps": list(LAYA_BF16_GAPS) if precision == "bf16" else [],
        "npu_claimable": False,
        "reason": (
            "static table probe only; NPU requires VitisAIExecutionProvider compile "
            "on a Strix Halo box with IOMMU enabled and vitisai_ep_report.json"
        ),
    }


def expected_laya_gaps(precision: str) -> dict[str, Any]:
    return {
        "precision": precision,
        "laya_architecture": (
            "ModernBERT-large encoder + 2-layer nn.TransformerEncoder head "
            "+ option-marker scorer + act_head (convaiinnovations/laya)"
        ),
        "bf16_table_gaps": list(LAYA_BF16_GAPS),
        "note": (
            "Ryzen AI 1.8 BF16 column does not mark Softmax, Gelu, or LayerNormalization. "
            "Those appear in both the encoder and the decision head, so a BF16 graph is "
            "expected to CPU-partition unless INT8 quantization is used and the assignment "
            "report still clears LAYA_NPU_ASSIGNMENT_THRESHOLD."
        ),
        "npu_claimable": False,
        "requires": [
            "Ryzen AI Software 1.8",
            "VitisAIExecutionProvider",
            "host IOMMU enabled (amd_iommu=off disables the NPU)",
            "physical Strix Halo NPU",
            "vitisai_ep_report.json with npu_fraction >= threshold",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe Laya ONNX against Ryzen AI 1.8 ops")
    parser.add_argument("--onnx", type=Path, default=None)
    parser.add_argument("--precision", choices=("bf16", "int8"), default="bf16")
    args = parser.parse_args(argv)
    if args.onnx is None:
        report = expected_laya_gaps(args.precision)
    else:
        report = probe_onnx(args.onnx, args.precision)
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
