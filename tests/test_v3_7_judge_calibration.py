"""v3 item 7 - before trusting an AI judge, check it against answers a person labelled.
tasks/judge_labels.jsonl holds 12 replies hand-labelled PASS / FAIL for "polite and clear"."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LABELS = [json.loads(l) for l in (ROOT / "tasks" / "judge_labels.jsonl").read_text().splitlines() if l.strip()]
TRUTH = {e["reply"]: e["label"] for e in LABELS}


class Data(unittest.TestCase):
    """Already green: guards the hand-labelled file."""

    def test_shape(self):
        self.assertGreaterEqual(len(LABELS), 12)
        self.assertEqual(len(TRUTH), len(LABELS))
        for want in ("PASS", "FAIL"):
            self.assertGreaterEqual(sum(e["label"] == want for e in LABELS), 4)
        self.assertTrue(all(set(e) == {"reply", "label"} for e in LABELS))


class Calibrate(unittest.TestCase):
    def test_a_judge_that_matches_the_person_is_usable(self):
        from evals.judge_calibration import calibrate
        out = calibrate(lambda reply: TRUTH[reply], LABELS)
        self.assertEqual(out, {"n": 12, "agree": 12, "agreement": 1.0, "unknown": 0,
                               "false_pass": 0, "false_fail": 0, "usable": True, "disagreements": []})

    def test_a_judge_that_passes_everything_is_not(self):
        from evals.judge_calibration import calibrate
        out = calibrate(lambda reply: "PASS", LABELS)
        self.assertEqual(out["agree"], 6)
        self.assertEqual(out["agreement"], 0.5)
        self.assertEqual(out["false_pass"], 6)      # judge said PASS, the person said FAIL: the dangerous kind
        self.assertEqual(out["false_fail"], 0)
        self.assertIs(out["usable"], False)
        self.assertEqual(len(out["disagreements"]), 6)
        self.assertEqual(set(out["disagreements"][0]), {"reply", "label", "judge"})

    def test_unknown_is_counted_separately_and_never_agrees(self):
        from evals.judge_calibration import calibrate
        out = calibrate(lambda reply: "UNKNOWN", LABELS)
        self.assertEqual((out["agree"], out["unknown"], out["false_pass"], out["false_fail"]), (0, 12, 0, 0))
        self.assertIs(out["usable"], False)

    def test_usable_needs_ten_of_twelve(self):
        from evals.judge_calibration import calibrate
        fails = [e["reply"] for e in LABELS if e["label"] == "FAIL"]

        def judge_wrong_on(n):
            wrong = set(fails[:n])
            return lambda reply: "PASS" if reply in wrong else TRUTH[reply]

        self.assertIs(calibrate(judge_wrong_on(2), LABELS)["usable"], True)     # 10/12 = 83%
        self.assertIs(calibrate(judge_wrong_on(3), LABELS)["usable"], False)    # 9/12 = 75%

    def test_judge_output_is_normalised(self):
        from evals.judge_calibration import calibrate
        out = calibrate(lambda reply: f"  {TRUTH[reply].lower()}\n", LABELS)
        self.assertEqual(out["agree"], 12)
        out = calibrate(lambda reply: "banana", LABELS)
        self.assertEqual(out["unknown"], 12)

    def test_empty_set(self):
        from evals.judge_calibration import calibrate
        out = calibrate(lambda reply: "PASS", [])
        self.assertEqual((out["n"], out["agreement"], out["usable"]), (0, 0.0, False))


if __name__ == "__main__":
    unittest.main()
