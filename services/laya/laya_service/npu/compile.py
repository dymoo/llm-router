"""Compile a Laya ONNX graph with VitisAI EP and emit an assignment report.

This is an optional host-side tool. The deployed classifier defaults to CPU.
It never falls back to CPUExecutionProvider while claiming NPU.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ..errors import BackendConfigError
from .assignment import assert_npu_allowed, load_assignment_report


def vitisai_provider_options(
    *,
    cache_dir: Path,
    cache_key: str,
    report_path: Path,
    precision: str,
    config_file: Path | None,
) -> dict[str, str]:
    options = {
        "cache_dir": str(cache_dir),
        "cache_key": cache_key,
        "enable_cache_file_io_in_mem": "0",
    }
    if precision == "int8":
        options["target"] = "X2"
    else:
        if config_file is None:
            config_file = packaged_config()
        options["config_file"] = str(config_file)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    os.environ["XLNX_ONNX_EP_REPORT_FILE"] = str(report_path)
    return options


def packaged_config() -> Path:
    return Path(__file__).with_name("vai_ep_config.json")


def compile_onnx(
    *,
    onnx_path: Path,
    context_path: Path,
    cache_dir: Path,
    report_path: Path,
    precision: str,
    threshold: float,
    cache_key: str = "laya-decision-model",
) -> dict:
    import onnxruntime as ort

    providers = list(ort.get_available_providers())
    if "VitisAIExecutionProvider" not in providers:
        raise BackendConfigError(
            "VitisAIExecutionProvider missing. Install Ryzen AI 1.8 on the Strix Halo "
            "host with IOMMU enabled. This compile does not fall back to CPU."
        )
    cache_dir.mkdir(parents=True, exist_ok=True)
    context_path.parent.mkdir(parents=True, exist_ok=True)
    session_options = ort.SessionOptions()
    session_options.add_session_config_entry("ep.context_enable", "1")
    session_options.add_session_config_entry("ep.context_file_path", str(context_path))
    session_options.add_session_config_entry("ep.context_embed_mode", "1")
    session_options.log_severity_level = 2
    provider_options = vitisai_provider_options(
        cache_dir=cache_dir,
        cache_key=cache_key,
        report_path=report_path,
        precision=precision,
        config_file=None,
    )
    session = ort.InferenceSession(
        str(onnx_path),
        sess_options=session_options,
        providers=["VitisAIExecutionProvider"],
        provider_options=[provider_options],
    )
    active = list(session.get_providers())
    if active != ["VitisAIExecutionProvider"]:
        raise BackendConfigError(
            "ONNX Runtime activated %s; NPU compile refuses any CPU provider claim" % active
        )
    assignment = load_assignment_report(report_path)
    assert_npu_allowed(providers=active, assignment=assignment, threshold=threshold)
    return {
        "onnx_path": str(onnx_path),
        "ep_context_path": str(context_path),
        "report_path": str(report_path),
        "providers": active,
        "npu_nodes": assignment.npu_nodes,
        "cpu_nodes": assignment.cpu_nodes,
        "npu_fraction": assignment.npu_fraction,
        "unsupported": list(assignment.unsupported),
        "threshold": threshold,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compile Laya ONNX with VitisAI EP (requires Strix Halo, IOMMU on)"
    )
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--precision", choices=("bf16", "int8"), default="bf16")
    parser.add_argument("--threshold", type=float, default=0.95)
    args = parser.parse_args(argv)
    try:
        result = compile_onnx(
            onnx_path=args.onnx,
            context_path=args.context,
            cache_dir=args.cache_dir,
            report_path=args.report,
            precision=args.precision,
            threshold=args.threshold,
        )
    except BackendConfigError as exc:
        json.dump({"ok": False, "error": exc.message, "npu_claimable": False}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2
    json.dump({"ok": True, **result}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
