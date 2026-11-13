"""The 3D page explains refunds with its own copy of the shop's rules (web/policy.js).
These tests fail if that copy drifts from agent/env.py."""
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from agent.env import ORDERS
from harness.runner import run_suite

ROOT = Path(__file__).resolve().parent.parent
POLICY_JS = ROOT / "web" / "policy.js"


class PolicyMirror(unittest.TestCase):
    def test_orders_match_the_shop(self):
        text = POLICY_JS.read_text()
        block = re.search(r"// ORDERS-BEGIN\s*export const ORDERS = (\{.*?\});\s*// ORDERS-END", text, re.S)
        self.assertIsNotNone(block, "ORDERS block markers missing in web/policy.js")
        self.assertEqual(json.loads(block.group(1)), ORDERS)

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_page_agrees_with_shop_on_every_refund(self):
        files = [str(ROOT / "results" / "results.json")]
        files += [str(p) for p in (ROOT / "results").glob("*/results.json")]
        # plus a noisy mock run, which tries many wrong refunds
        res = None
        for ev in run_suite({"agent": "mock", "k": 10, "noise": 0.6, "seed": 7,
                             "tasks": str(ROOT / "tasks" / "tasks.jsonl")}):
            if ev["type"] == "run_finished":
                res = ev["results"]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(res, f)
        files.append(f.name)
        out = subprocess.run(["node", str(ROOT / "tests" / "policy_check.mjs"), *files],
                             cwd=ROOT, capture_output=True, text=True)
        report = json.loads(out.stdout)
        self.assertGreater(report["checked"], 10)
        self.assertEqual(report["mismatches"], [])


if __name__ == "__main__":
    unittest.main()
