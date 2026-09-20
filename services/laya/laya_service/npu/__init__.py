"""Optional Ryzen AI 1.8 VitisAI path. Deployed default is CPU."""

from .assignment import AssignmentReport, assert_npu_allowed, load_assignment_report, parse_assignment_report

__all__ = [
    "AssignmentReport",
    "assert_npu_allowed",
    "load_assignment_report",
    "parse_assignment_report",
]
