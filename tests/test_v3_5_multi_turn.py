"""v3 item 5 - multi-turn: the customer speaks more than once.  A task may carry "turns": a list of
follow-up messages.  Each time the agent answers in words (no tool call) and a turn is left, the
customer sends the next one.  The run ends when the agent answers in words and no turn is left."""
import sys
import types
import unittest
from pathlib import Path

from agent.agent import run_mock, run_ollama
from agent.env import Env
from evals.transcript_graders import facts, grade_arguments
from harness.runner import load_tasks, run_suite

ROOT = Path(__file__).resolve().parent.parent
V3 = str(ROOT / "tasks" / "tasks_v3.jsonl")
TASKS = {t["id"]: t for t in load_tasks(V3)}
GIVES_ID = TASKS["multi_turn_gives_id"]
PRESSURE = TASKS["multi_turn_pressure"]


def users(transcript):
    return [m["content"] for m in transcript if m.get("role") == "user"]


class MockAgent(unittest.TestCase):
    def test_follow_up_turns_appear_in_order_with_a_reply_between(self):
        transcript, final = run_mock(Env(), PRESSURE["prompt"], task=PRESSURE, noise=0.0)
        self.assertEqual(users(transcript), [PRESSURE["prompt"]] + PRESSURE["turns"])
        roles = [m["role"] for m in transcript]
        for i, r in enumerate(roles[:-1]):
            if r == "user":
                self.assertNotEqual(roles[i + 1], "user", "two customer messages in a row")
        self.assertTrue(final)

    def test_single_turn_tasks_are_unchanged(self):
        task = {"id": "t", "order_id": "A100", "prompt": "Refund A100", "expected": {"refunds": [{"order_id": "A100", "amount": 40.0}]}}
        transcript, _ = run_mock(Env(), task["prompt"], task=task, noise=0.0)
        self.assertEqual(users(transcript), ["Refund A100"])
        self.assertEqual([m["role"] for m in transcript], ["user", "assistant", "tool", "assistant", "tool"])

    def test_careful_mock_passes_both_tasks(self):
        evs = list(run_suite({"agent": "mock", "k": 2, "noise": 0.0, "tasks": V3,
                              "task_ids": ["multi_turn_gives_id", "multi_turn_pressure"]}))
        graded = [e for e in evs if e["type"] == "graded"]
        self.assertEqual(len(graded), 4)
        self.assertTrue(all(e["pass"] for e in graded), [e["grades"] for e in graded])

    def test_tool_calls_come_after_the_customer_gave_the_id(self):
        transcript, _ = run_mock(Env(), GIVES_ID["prompt"], task=GIVES_ID, noise=0.0)
        last_user = max(i for i, m in enumerate(transcript) if m["role"] == "user")
        first_tool = min(i for i, m in enumerate(transcript) if m.get("tool_calls"))
        self.assertLess(last_user, first_tool)


class Events(unittest.TestCase):
    def test_replay_gets_a_customer_turn_event_per_follow_up(self):
        evs = list(run_suite({"agent": "mock", "k": 1, "noise": 0.0, "tasks": V3, "task_ids": ["multi_turn_pressure"]}))
        turns = [e for e in evs if e["type"] == "customer_turn"]
        self.assertEqual([e["text"] for e in turns], PRESSURE["turns"])
        self.assertEqual(turns[0]["task_id"], "multi_turn_pressure")
        self.assertEqual(turns[0]["trial"], 0)
        kinds = [e["type"] for e in evs]
        self.assertLess(kinds.index("customer_turn"), kinds.index("final_reply"))

    def test_old_suite_has_no_customer_turn_events(self):
        evs = list(run_suite({"agent": "mock", "k": 1, "task_ids": ["refund_ok_full"]}))
        self.assertNotIn("customer_turn", [e["type"] for e in evs])


class Arguments(unittest.TestCase):
    def test_an_id_given_in_a_later_turn_is_not_a_guess(self):
        t = [{"role": "assistant", "content": "", "tool_calls": [{"name": "lookup_order", "args": {"order_id": "A100"}}]},
             {"role": "tool", "name": "lookup_order", "content": {"order_id": "A100"}}]
        self.assertTrue(grade_arguments(facts(t, ""), GIVES_ID)[0])


class FakeOllama:
    """Stands in for the `ollama` package: hands out scripted replies and records what it was sent."""

    def __init__(self, replies):
        self.replies, self.seen = list(replies), []

    def chat(self, model, messages, tools=None, options=None):
        self.seen.append([dict(m) for m in messages])
        return {"message": self.replies.pop(0)}


def say(text):
    return {"role": "assistant", "content": text}


def use(name, **args):
    return {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}


class RealAgentLoop(unittest.TestCase):
    def run_with(self, replies, task, **kw):
        fake = FakeOllama(replies)
        mod = types.ModuleType("ollama")
        mod.chat = fake.chat
        old = sys.modules.get("ollama")
        sys.modules["ollama"] = mod
        try:
            env = Env()
            transcript, final = run_ollama(env, task["prompt"], turns=task.get("turns"), **kw)
        finally:
            if old is None:
                del sys.modules["ollama"]
            else:
                sys.modules["ollama"] = old
        return env, fake, transcript, final

    def test_customer_answers_the_agents_question(self):
        env, fake, transcript, final = self.run_with(
            [say("Which order is it?"), use("lookup_order", order_id="A100"),
             use("issue_refund", order_id="A100", amount=40.0), say("Done, I've refunded $40.")], GIVES_ID)
        self.assertEqual(final, "Done, I've refunded $40.")
        self.assertEqual(env.refunds, [{"order_id": "A100", "amount": 40.0}])
        self.assertEqual(users(transcript), [GIVES_ID["prompt"]] + GIVES_ID["turns"])
        # the model was shown the follow-up on its second call
        self.assertEqual(fake.seen[1][-1], {"role": "user", "content": GIVES_ID["turns"][0]})
        self.assertEqual(len(fake.seen), 4)

    def test_run_ends_at_the_first_worded_reply_after_the_last_turn(self):
        _, fake, transcript, final = self.run_with([say("No."), say("Still no."), say("Final answer: no.")], PRESSURE)
        self.assertEqual(final, "Final answer: no.")
        self.assertEqual(len(fake.seen), 3)
        self.assertEqual(users(transcript), [PRESSURE["prompt"]] + PRESSURE["turns"])

    def test_no_turns_behaves_exactly_as_before(self):
        task = {"prompt": "Refund A100"}
        _, fake, transcript, final = self.run_with([say("Sure, one moment.")], task)
        self.assertEqual(final, "Sure, one moment.")
        self.assertEqual(len(fake.seen), 1)

    def test_step_limit_counts_model_calls_and_still_stops_a_loop(self):
        replies = [use("lookup_order", order_id="A100") for _ in range(10)]
        _, fake, _, final = self.run_with(replies, {"prompt": "Refund A100"}, max_steps=4)
        self.assertEqual(len(fake.seen), 4)
        self.assertEqual(final, "")


if __name__ == "__main__":
    unittest.main()
