"""Parse vitisai_ep_report.json and refuse NPU below the assignment threshold.

Ryzen AI 1.8 generates this report only when enable_cache_file_io_in_mem=0 and
XLNX_ONNX_EP_REPORT_FILE is set. Missing reports fail closed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import BackendConfigError

NPU_NAMES = frozenset({"npu", "aie", "dpu", "vitisai", "vaiml", "stx"})
CPU_NAMES = frozenset({"cpu", "host"})


@dataclass(frozen=True)
class AssignmentReport:
    npu_nodes: int
    cpu_nodes: int
    unsupported: tuple[str, ...] = ()
    path: str | None = None
    devices: tuple[str, ...] = ()
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    @property
    def total_nodes(self) -> int:
        return self.npu_nodes + self.cpu_nodes

    @property
    def npu_fraction(self) -> float:
        if self.total_nodes <= 0:
            return 0.0
        return self.npu_nodes / self.total_nodes

    def allowed(self, threshold: float) -> bool:
        return self.npu_nodes > 0 and self.npu_fraction + 1e-12 >= threshold


def parse_assignment_report(raw: Any, *, path: str | None = None) -> AssignmentReport:
    if not isinstance(raw, dict):
        raise BackendConfigError("operator assignment report is not a JSON object")
    npu = cpu = 0
    unsupported: list[str] = []
    devices: list[str] = []
    stats = raw.get("deviceStat") or raw.get("deviceStats") or raw.get("devices")
    if isinstance(stats, list):
        for item in stats:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("device") or "").strip().lower()
            nodes = _node_count(item)
            devices.append(name or "unknown")
            if name in NPU_NAMES:
                npu += nodes
            elif name in CPU_NAMES or name == "":
                cpu += nodes
            else:
                cpu += nodes
            extra = item.get("unsupportedOpType") or item.get("unsupportedOps") or []
            if isinstance(extra, list):
                unsupported.extend(str(op) for op in extra)
    else:
        npu = _first_int(raw, ("npuOps", "npu_ops", "npuNodeNum", "NPU"))
        cpu = _first_int(raw, ("cpuOps", "cpu_ops", "cpuNodeNum", "CPU"))
        extra = raw.get("unsupportedOps") or raw.get("unsupportedOpType") or []
        if isinstance(extra, list):
            unsupported = [str(op) for op in extra]
    if npu == 0 and cpu == 0:
        raise BackendConfigError("operator assignment report contains no node counts")
    return AssignmentReport(
        npu_nodes=npu,
        cpu_nodes=cpu,
        unsupported=tuple(unsupported),
        path=path,
        devices=tuple(devices),
        raw=raw,
    )


def load_assignment_report(path: Path) -> AssignmentReport:
    if not path.is_file():
        raise BackendConfigError(
            f"NPU assignment report missing at {path}; refuse to claim VitisAI without it"
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BackendConfigError("NPU assignment report is not valid JSON") from exc
    return parse_assignment_report(raw, path=str(path))


def assert_npu_allowed(
    *,
    providers: list[str],
    assignment: AssignmentReport | None,
    threshold: float,
) -> AssignmentReport:
    if "VitisAIExecutionProvider" not in providers:
        raise BackendConfigError(
            "VitisAIExecutionProvider is not available; NPU mode requires Ryzen AI 1.8"
        )
    if assignment is None:
        raise BackendConfigError("NPU mode requires a VitisAI operator assignment report")
    if not assignment.allowed(threshold):
        raise BackendConfigError(
            "NPU assignment %.4f is below LAYA_NPU_ASSIGNMENT_THRESHOLD %.4f "
            "(npu_nodes=%d cpu_nodes=%d); refusing to claim NPU"
            % (assignment.npu_fraction, threshold, assignment.npu_nodes, assignment.cpu_nodes)
        )
    return assignment


def _node_count(item: dict[str, Any]) -> int:
    for key in ("nodeNum", "node_num", "nodes", "opNum", "opCount"):
        value = item.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return 0


def _first_int(raw: dict[str, Any], keys: tuple[str, ...]) -> int:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, dict):
            nested = _node_count(value)
            if nested:
                return nested
    return 0
