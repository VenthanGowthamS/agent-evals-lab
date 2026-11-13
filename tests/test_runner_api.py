"""The event-stream runner and the FastAPI service around it (mock agent only: no model needed)."""
import json
import os
import time
import unittest

from harness.runner import run_suite, summarize

try:
    from fastapi.testclient import TestClient
    from api import main as api
    HAVE_API = True
except Exception:  # fastapi/httpx not installed: runner tests still run
    HAVE_API = False


class Runner(unittest.TestCase):
    def run_once(self, **cfg):
        return list(run_suite({"agent": "mock", "k": 3, "seed": 7, **cfg}))

    def test_same_seed_same_grades(self):
        a, b = self.run_once(), self.run_once()
        strip = lambda evs: [(e["task_id"], e["trial"], e["pass"], e["failure_label"]) for e in evs if e["type"] == "graded"]
        self.assertEqual(strip(a), strip(b))

    def test_event_order(self):
        evs = self.run_once(task_ids=["refund_ok_full"])
        kinds = [e["type"] for e in evs]
        self.assertEqual(kinds[0], "run_started")
        self.assertEqual(kinds[-1], "run_finished")
        self.assertEqual(kinds.count("trial_started"), 3)
        self.assertEqual(kinds.count("graded"), 3)
        first = kinds.index("trial_started")
        self.assertLess(first, kinds.index("graded"))
        for e in evs:
            if e["type"] == "tool_result":
                self.assertIn("blocked", e)

    def test_live_steps_stream_during_the_trial(self):
        plain = self.run_once(task_ids=["refund_ok_full", "safety_fake_approval"])
        live = self.run_once(task_ids=["refund_ok_full", "safety_fake_approval"], live_steps=True)
        grades = lambda evs: [(e["task_id"], e["trial"], e["pass"]) for e in evs if e["type"] == "graded"]
        self.assertEqual(grades(plain), grades(live))           # same seed, same results with or without live steps
        self.assertNotIn("live_step", [e["type"] for e in plain])
        kinds = [e["type"] for e in live]
        self.assertGreater(kinds.count("live_step"), 0)
        # every live step of a trial arrives before that trial is graded
        for i, e in enumerate(live):
            if e["type"] == "live_step":
                later = [x for x in live[i:] if x["type"] == "graded" and x["task_id"] == e["task_id"] and x["trial"] == e["trial"]]
                self.assertTrue(later)
                self.assertIn("blocked", e)

    def test_summary(self):
        s = self.run_once()[-1]["summary"]
        self.assertEqual(s["tasks"], 12)
        self.assertEqual(s["trials"], 36)
        self.assertTrue(0 <= s["ci95"][0] <= s["avg_pass_rate"] + 0.2)
        self.assertEqual(summarize({}), {"tasks": 0})


@unittest.skipUnless(HAVE_API, "fastapi and httpx are needed for the API tests")
class Api(unittest.TestCase):
    def setUp(self):
        self.c = TestClient(api.app)
        api.RUNS.clear()
        os.environ.pop("EVALS_MOCK_ONLY", None)

    def wait(self, run_id):
        for _ in range(200):
            if api.RUNS[run_id].status != "running":
                return
            time.sleep(0.02)
        self.fail("run did not finish")

    def tearDown(self):
        for r in list(api.RUNS.values()):
            f = api.RUNS_DIR / f"{r.id}.json"
            if f.exists():
                f.unlink()

    def test_health_and_tasks(self):
        self.assertTrue(self.c.get("/api/health").json()["ok"])
        self.assertEqual(len(self.c.get("/api/tasks").json()), 12)

    def test_baseline_run_is_listed_and_readable(self):
        ids = [r["id"] for r in self.c.get("/api/runs").json()]
        self.assertIn("baseline", ids)
        self.assertEqual(len(self.c.get("/api/runs/baseline").json()), 12)
        self.assertEqual(self.c.get("/api/runs/nope").status_code, 404)

    def test_start_run_stream_and_save(self):
        r = self.c.post("/api/runs", json={"agent": "mock", "k": 2, "seed": 1})
        self.assertEqual(r.status_code, 202)
        rid = r.json()["id"]
        self.wait(rid)
        body = self.c.get(f"/api/runs/{rid}/events").text
        self.assertIn("event: run_started", body)
        self.assertIn("event: graded", body)
        self.assertIn("event: run_finished", body)
        last = [l for l in body.splitlines() if l.startswith("data: ")][-1]
        self.assertEqual(json.loads(last[6:])["summary"]["trials"], 24)
        self.assertEqual(len(self.c.get(f"/api/runs/{rid}").json()), 12)

    def test_limits(self):
        self.assertEqual(self.c.post("/api/runs", json={"k": 11}).status_code, 422)
        self.assertEqual(self.c.post("/api/runs", json={"task_ids": ["nope"]}).status_code, 422)
        os.environ["EVALS_MOCK_ONLY"] = "1"
        self.assertEqual(self.c.post("/api/runs", json={"agent": "ollama"}).status_code, 403)

    def test_one_run_at_a_time(self):
        busy = api.Run("busy", {})
        api.RUNS["busy"] = busy
        self.assertEqual(self.c.post("/api/runs", json={"agent": "mock"}).status_code, 409)
        busy.status = "finished"

    def test_page_and_results_are_served(self):
        self.assertEqual(self.c.get("/results/results.json").status_code, 200)


if __name__ == "__main__":
    unittest.main()
