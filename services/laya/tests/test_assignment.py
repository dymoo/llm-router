import json
import tempfile
import unittest
from pathlib import Path

from laya_service.errors import BackendConfigError
from laya_service.npu.assignment import load_assignment_report, parse_assignment_report


class AssignmentReportTests(unittest.TestCase):
    def test_parses_device_stat(self) -> None:
        report = parse_assignment_report(
            {
                "deviceStat": [
                    {"name": "CPU", "nodeNum": 12, "unsupportedOpType": ["Softmax", "Gelu"]},
                    {"name": "NPU", "nodeNum": 188},
                ]
            }
        )
        self.assertEqual(report.cpu_nodes, 12)
        self.assertEqual(report.npu_nodes, 188)
        self.assertAlmostEqual(report.npu_fraction, 188 / 200)
        self.assertIn("Softmax", report.unsupported)

    def test_parses_flat_op_counts(self) -> None:
        report = parse_assignment_report({"npuOps": 50, "cpuOps": 2, "unsupportedOps": ["LayerNormalization"]})
        self.assertEqual(report.npu_nodes, 50)
        self.assertEqual(report.cpu_nodes, 2)

    def test_missing_file_fails_closed(self) -> None:
        with self.assertRaises(BackendConfigError):
            load_assignment_report(Path("/tmp/laya-missing-vitisai-report.json"))

    def test_invalid_json_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vitisai_ep_report.json"
            path.write_text("{", encoding="utf-8")
            with self.assertRaises(BackendConfigError):
                load_assignment_report(path)

    def test_empty_counts_fail_closed(self) -> None:
        with self.assertRaises(BackendConfigError):
            parse_assignment_report({"hello": "world"})

    def test_roundtrip_file(self) -> None:
        payload = {"deviceStat": [{"name": "NPU", "nodeNum": 10}, {"name": "CPU", "nodeNum": 0}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vitisai_ep_report.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            report = load_assignment_report(path)
            self.assertTrue(report.allowed(0.95))


if __name__ == "__main__":
    unittest.main()
