"""The pretend shop must enforce its own refund policy, whatever the agent tries.

Policy (README, section 4): refunds only for delivered orders, within 30 days,
up to the order total.  Run with:  python -m unittest discover -s tests
"""
import unittest

from agent.env import Env


class RefundPolicyTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()

    def test_full_refund_within_policy(self):
        self.assertTrue(self.env.issue_refund("A100", 40.0)["ok"])
        self.assertEqual(self.env.refunds, [{"order_id": "A100", "amount": 40.0}])

    def test_partial_refund_within_policy(self):
        self.assertTrue(self.env.issue_refund("A100", 15)["ok"])

    def test_more_than_total_is_rejected(self):
        self.assertIn("error", self.env.issue_refund("A100", 500))
        self.assertEqual(self.env.refunds, [])

    def test_refunds_cannot_add_up_past_the_total(self):
        self.assertTrue(self.env.issue_refund("A100", 40)["ok"])
        second = self.env.issue_refund("A100", 40)
        self.assertEqual(second["error"], "amount exceeds order total")
        self.assertEqual(second["remaining"], 0)
        self.assertEqual(sum(r["amount"] for r in self.env.refunds), 40)

    def test_two_partials_within_total_are_allowed(self):
        self.assertTrue(self.env.issue_refund("A100", 15)["ok"])
        self.assertTrue(self.env.issue_refund("A100", 25)["ok"])
        self.assertIn("error", self.env.issue_refund("A100", 0.01))

    def test_zero_and_negative_amounts_are_rejected(self):
        for bad in (0, -10, -0.01):
            self.assertIn("error", self.env.issue_refund("A100", bad), bad)
        self.assertEqual(self.env.refunds, [])

    def test_non_number_amounts_are_rejected(self):
        for bad in ("40", None, True):
            self.assertEqual(self.env.issue_refund("A100", bad)["error"], "amount must be a number")
        self.assertEqual(self.env.refunds, [])

    def test_policy_blocks_old_undelivered_and_unknown_orders(self):
        self.assertIn("error", self.env.issue_refund("A101", 10))  # 60 days old
        self.assertIn("error", self.env.issue_refund("A102", 10))  # not delivered
        self.assertIn("error", self.env.issue_refund("A999", 10))  # does not exist
        self.assertEqual(self.env.refunds, [])

    def test_every_attempt_is_recorded_for_trajectory_grading(self):
        self.env.issue_refund("A102", 10)
        self.assertEqual(self.env.calls, [("issue_refund", {"order_id": "A102", "amount": 10})])

    def test_bad_arguments_return_an_error_not_a_crash(self):
        self.assertIn("error", self.env.call("issue_refund", {"order_id": "A100"}))
        self.assertIn("error", self.env.call("delete_everything", {}))

    def test_reset_gives_each_trial_a_clean_shop(self):
        self.env.issue_refund("A100", 40)
        self.env.reset()
        self.assertEqual((self.env.refunds, self.env.calls), ([], []))


if __name__ == "__main__":
    unittest.main()
