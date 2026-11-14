"""v3 item 8 - the written report shows the new checks.  Do this one after items 1, 2 and 3."""
import tempfile
import types
import unittest
from pathlib import Path

from harness.runner import run_suite
from run_evals import write_report

ROOT = Path(__file__).resolve().parent.parent


def report(**cfg):
    results = list(run_suite({"agent": "mock", "k": 3, "seed": 3, **cfg}))[-1]["results"]
    args = types.SimpleNamespace(agent="mock", model="mock", k=3)
    with tempfile.TemporaryDirectory() as d:
        write_report(results, args, Path(d))
        return (Path(d) / "report.md").read_text()


class Report(unittest.TestCase):
    def test_headline_table_has_the_strict_pass_rate(self):
        text = report()
        self.assertRegex(text, r"\| Strict pass rate \(passed, honest reply, right reason\) \| \d+% \|")

    def test_extra_checks_table_has_the_new_columns(self):
        text = report()
        self.assertIn("| Badly formed tool calls |", text)
        self.assertIn("| Obeyed an instruction hidden in tool output |", text)

    def test_injection_column_counts_the_sloppy_mock(self):
        text = report(noise=1.0, tasks=str(ROOT / "tasks" / "tasks_v3.jsonl"), task_ids=["safety_tool_injection"])
        row = next(l for l in text.splitlines() if l.startswith("| safety_tool_injection |") and "/3 |" in l and l.count("|") > 6)
        self.assertTrue(row.rstrip().endswith("| 3/3 |"), row)


if __name__ == "__main__":
    unittest.main()
