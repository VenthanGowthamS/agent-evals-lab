"""v3 item 6 - compare two recorded runs (two models, or the same model twice) and say honestly
whether the difference is bigger than the noise."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "results" / "results.json"
B = ROOT / "results" / "rerun-2026-11-13" / "results.json"


def rec(passes, k=5):
    return {"passes": passes, "k": k, "trials": []}


class Compare(unittest.TestCase):
    def test_per_task_rates_and_difference(self):
        from compare import compare
        out = compare({"t1": rec(5), "t2": rec(1)}, {"t1": rec(4), "t2": rec(4)})
        self.assertEqual(out["tasks"]["t1"], {"a": 1.0, "b": 0.8, "diff": -0.2})
        self.assertEqual(out["tasks"]["t2"], {"a": 0.2, "b": 0.8, "diff": 0.6})

    def test_overall_block(self):
        from compare import compare
        o = compare({"t1": rec(5), "t2": rec(1)}, {"t1": rec(4), "t2": rec(4)})["overall"]
        self.assertEqual((o["a"]["passed"], o["a"]["trials"], o["a"]["rate"]), (6, 10, 0.6))
        self.assertEqual((o["b"]["passed"], o["b"]["trials"], o["b"]["rate"]), (8, 10, 0.8))
        self.assertAlmostEqual(o["diff"], 0.2)
        lo, hi = o["a"]["ci95"]
        self.assertTrue(lo < 0.6 < hi)

    def test_verdict_needs_intervals_that_do_not_overlap(self):
        from compare import compare
        big = lambda p: {f"t{i}": rec(p, 10) for i in range(10)}     # 100 trials each
        self.assertEqual(compare(big(2), big(9))["overall"]["verdict"], "b_better")
        self.assertEqual(compare(big(9), big(2))["overall"]["verdict"], "a_better")
        self.assertEqual(compare(big(7), big(8))["overall"]["verdict"], "no_clear_difference")

    def test_only_shared_tasks_are_compared(self):
        from compare import compare
        out = compare({"t1": rec(5), "old": rec(5)}, {"t1": rec(5), "new": rec(0)})
        self.assertEqual(set(out["tasks"]), {"t1"})
        self.assertEqual(out["only_in_a"], ["old"])
        self.assertEqual(out["only_in_b"], ["new"])
        self.assertEqual(out["overall"]["b"]["trials"], 5)

    def test_the_two_recorded_qwen_runs_are_not_clearly_different(self):
        from compare import compare
        out = compare(json.loads(A.read_text()), json.loads(B.read_text()))
        self.assertEqual(out["overall"]["a"]["passed"], 43)
        self.assertEqual(out["overall"]["b"]["passed"], 47)
        self.assertEqual(out["overall"]["verdict"], "no_clear_difference")


class Cli(unittest.TestCase):
    def test_main_returns_a_markdown_table(self):
        from compare import main
        text = main([str(A), str(B), "--names", "first run", "re-run"])
        self.assertIn("| Task | first run | re-run | Change |", text)
        self.assertIn("| refund_ok_full |", text)
        self.assertIn("43/60", text)
        self.assertIn("47/60", text)
        self.assertIn("No clear difference", text)


if __name__ == "__main__":
    unittest.main()
