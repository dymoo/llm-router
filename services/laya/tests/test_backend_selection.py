import unittest

from laya_service.errors import BackendConfigError
from laya_service.npu.assignment import AssignmentReport, assert_npu_allowed, parse_assignment_report


class BackendSelectionTests(unittest.TestCase):
    def test_cpu_is_explicit_and_npu_does_not_fallback(self) -> None:
        with self.assertRaises(BackendConfigError):
            assert_npu_allowed(
                providers=["CPUExecutionProvider"],
                assignment=AssignmentReport(npu_nodes=10, cpu_nodes=0),
                threshold=0.95,
            )

    def test_missing_vitisai_refuses_npu(self) -> None:
        with self.assertRaises(BackendConfigError):
            assert_npu_allowed(
                providers=["CPUExecutionProvider", "AzureExecutionProvider"],
                assignment=None,
                threshold=0.95,
            )

    def test_missing_report_refuses_npu(self) -> None:
        with self.assertRaises(BackendConfigError):
            assert_npu_allowed(
                providers=["VitisAIExecutionProvider"],
                assignment=None,
                threshold=0.95,
            )

    def test_cpu_partition_below_threshold_refuses(self) -> None:
        report = AssignmentReport(npu_nodes=10, cpu_nodes=90)
        self.assertFalse(report.allowed(0.95))
        with self.assertRaises(BackendConfigError) as ctx:
            assert_npu_allowed(
                providers=["VitisAIExecutionProvider"],
                assignment=report,
                threshold=0.95,
            )
        self.assertIn("refusing to claim NPU", ctx.exception.message)

    def test_high_npu_fraction_allows(self) -> None:
        report = AssignmentReport(npu_nodes=99, cpu_nodes=1)
        allowed = assert_npu_allowed(
            providers=["VitisAIExecutionProvider"],
            assignment=report,
            threshold=0.95,
        )
        self.assertEqual(allowed.npu_nodes, 99)

    def test_zero_npu_nodes_never_allowed(self) -> None:
        report = parse_assignment_report(
            {"deviceStat": [{"name": "CPU", "nodeNum": 40}, {"name": "NPU", "nodeNum": 0}]}
        )
        self.assertEqual(report.npu_fraction, 0.0)
        with self.assertRaises(BackendConfigError):
            assert_npu_allowed(
                providers=["VitisAIExecutionProvider"],
                assignment=report,
                threshold=0.01,
            )


if __name__ == "__main__":
    unittest.main()
