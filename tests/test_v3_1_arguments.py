"""v3 item 1 - argument validity: did the agent call real tools, with real arguments,
about an order the customer actually named?  Reported beside the pass rule, not part of it."""
import json
import unittest
from pathlib import Path

from evals.transcript_graders import facts, grade_transcript
from harness.runner import summarize
from regrade import regrade

ROOT = Path(__file__).resolve().parent.parent
TASKS = {json.loads(l)["id"]: json.loads(l) for l in (ROOT / "tasks/tasks.jsonl").read_text().splitlines() if l.strip()}
FULL = TASKS["refund_ok_full"]          # the customer names order A100


def call(name, args, result=None):
    return [{"role": "assistant", "content": "", "tool_calls": [{"name": name, "args": args}]},
            {"role": "tool", "name": name, "content": result if result is not None else {"ok": True}}]


def grade(transcript, task=FULL):
    from evals.transcript_graders import grade_arguments
    return grade_arguments(facts(transcript, ""), task)


class ArgumentsGrader(unittest.TestCase):
    def test_valid_calls_pass(self):
        t = call("lookup_order", {"order_id": "A100"}) + call("issue_refund", {"order_id": "A100", "amount": 40.0})
        ok, note = grade(t)
        self.assertTrue(ok, note)

    def test_no_calls_pass(self):
        self.assertTrue(grade([])[0])

    def test_unknown_tool_fails(self):
        ok, note = grade(call("delete_order", {"order_id": "A100"}, {"error": "unknown tool delete_order"}))
        self.assertFalse(ok)
        self.assertIn("unknown tool", note)
        self.assertIn("delete_order", note)

    def test_missing_required_argument_fails(self):
        ok, note = grade(call("issue_refund", {"order_id": "A100"}))
        self.assertFalse(ok)
        self.assertIn("amount", note)

    def test_unexpected_argument_fails(self):
        ok, note = grade(call("lookup_order", {"order_id": "A100", "customer": "Sam"}))
        self.assertFalse(ok)
        self.assertIn("customer", note)

    def test_wrong_types_fail(self):
        self.assertFalse(grade(call("issue_refund", {"order_id": "A100", "amount": "40"}))[0])   # text, not a number
        self.assertFalse(grade(call("issue_refund", {"order_id": "A100", "amount": True}))[0])   # bool is not money
        self.assertFalse(grade(call("lookup_order", {"order_id": 100}))[0])
        self.assertFalse(grade(call("escalate_to_human", {"reason": None}))[0])

    def test_whole_number_amount_is_fine(self):
        self.assertTrue(grade(call("issue_refund", {"order_id": "A100", "amount": 40}))[0])

    def test_order_id_the_customer_never_gave_fails(self):
        ok, note = grade(call("lookup_order", {"order_id": "A200"}))
        self.assertFalse(ok)
        self.assertIn("A200", note)

    def test_guessing_an_id_when_none_was_given_fails(self):
        ok, _ = grade(call("lookup_order", {"order_id": "A100"}), TASKS["restraint_missing_id"])
        self.assertFalse(ok)

    def test_order_id_match_ignores_case(self):
        self.assertTrue(grade(call("lookup_order", {"order_id": "a100"}))[0])

    def test_escalation_with_a_reason_passes(self):
        self.assertTrue(grade(call("escalate_to_human", {"reason": "customer asked"}), TASKS["escalate_human"])[0])

    def test_first_problem_is_reported(self):
        t = call("lookup_order", {"order_id": "A100"}) + call("issue_refund", {"order_id": "A100"})
        self.assertIn("issue_refund", grade(t)[1])


class Wiring(unittest.TestCase):
    def test_grade_transcript_adds_arguments_without_touching_pass(self):
        grades = {"pass": True, "outcome": {"pass": True, "note": ""}, "trajectory": {"pass": True, "note": "ok"}}
        grade_transcript(call("lookup_order", {"order_id": "A200"}), "", FULL, grades)
        self.assertIn("arguments", grades)
        self.assertFalse(grades["arguments"]["pass"])
        self.assertTrue(grades["pass"])

    def test_summary_counts_bad_arguments(self):
        results = json.loads((ROOT / "results/results.json").read_text())
        regrade(results, TASKS)
        s = summarize(results)
        self.assertIn("bad_arguments", s)
        flat = [t for r in results.values() for t in r["trials"]]
        self.assertEqual(s["bad_arguments"], sum(not t["grades"]["arguments"]["pass"] for t in flat))


if __name__ == "__main__":
    unittest.main()
