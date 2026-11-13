"""The harness as a stream of events. The CLI, the API and the tests all consume run_suite()."""
import json
import random
import time
from pathlib import Path

from agent.agent import run_mock, run_ollama
from agent.env import Env
from evals.graders import grade_all
from evals.stats import wilson
from evals.transcript_graders import grade_transcript

DEFAULTS = {"agent": "mock", "model": "qwen2.5:3b", "k": 5, "noise": 0.25,
            "tasks": "tasks/tasks.jsonl", "seed": 0, "task_ids": None}


def load_tasks(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def run_trial(task, cfg, rng):
    env = Env()          # fresh environment every trial: runs cannot contaminate each other
    t0 = time.time()
    if cfg["agent"] == "ollama":
        transcript, final = run_ollama(env, task["prompt"], model=cfg["model"])
    else:
        transcript, final = run_mock(env, task["prompt"], task=task, noise=cfg["noise"], rng=rng)
    grades = grade_all(env, task)
    extras = grade_transcript(transcript, final, task, grades)
    return {"grades": grades, "transcript": transcript, "final": final,
            "latency_s": round(time.time() - t0, 2), "tool_calls": len(env.calls), **extras}


def trial_events(task_id, n, trial):
    """Turn one finished trial into the step events a viewer replays."""
    base = {"task_id": task_id, "trial": n}
    pending = []
    for m in trial["transcript"]:
        if m.get("role") == "assistant":
            for c in m.get("tool_calls") or []:
                pending.append(c["name"])
                yield {"type": "tool_call", **base, "name": c["name"], "args": c.get("args") or {}}
        elif m.get("role") == "tool":
            res = m.get("content")
            blocked = m.get("name") == "issue_refund" and not (isinstance(res, dict) and res.get("ok"))
            yield {"type": "tool_result", **base, "name": m.get("name"), "result": res, "blocked": blocked}
    yield {"type": "final_reply", **base, "text": trial["final"]}
    yield {"type": "graded", **base, "pass": trial["grades"]["pass"], "grades": trial["grades"],
           "failure_label": trial["failure_label"], "record": trial}


def run_suite(config=None):
    """Run every task k times. Yields events; the last one is run_finished with the summary."""
    cfg = {**DEFAULTS, **(config or {})}
    rng = random.Random(cfg["seed"])
    tasks = load_tasks(cfg["tasks"])
    if cfg["task_ids"]:
        tasks = [t for t in tasks if t["id"] in set(cfg["task_ids"])]
    yield {"type": "run_started", "config": {k: v for k, v in cfg.items()}, "tasks": len(tasks)}
    results = {}
    for task in tasks:
        trials = []
        for n in range(cfg["k"]):
            yield {"type": "trial_started", "task_id": task["id"], "trial": n,
                   "capability": task["capability"], "prompt": task["prompt"]}
            trial = run_trial(task, cfg, rng)
            trials.append(trial)
            yield from trial_events(task["id"], n, trial)
        passes = [t["grades"]["pass"] for t in trials]
        results[task["id"]] = {
            "capability": task["capability"],
            "passes": sum(passes), "k": cfg["k"],
            "pass_at_k": any(passes),          # at least one run succeeded
            "pass_pow_k": all(passes),         # every run succeeded (what users feel)
            "avg_tool_calls": round(sum(t["tool_calls"] for t in trials) / cfg["k"], 2),
            "avg_latency_s": round(sum(t["latency_s"] for t in trials) / cfg["k"], 2),
            "trials": trials,
        }
        yield {"type": "task_finished", "task_id": task["id"], "record": results[task["id"]]}
    yield {"type": "run_finished", "summary": summarize(results), "results": results}


def summarize(results):
    """Headline numbers for a results dict (also works on a saved results.json)."""
    n = len(results)
    if not n:
        return {"tasks": 0}
    trials = sum(r["k"] for r in results.values())
    passed = sum(r["passes"] for r in results.values())
    lo, hi = wilson(passed, trials)
    flat = [t for r in results.values() for t in r["trials"]]
    labels = {}
    for t in flat:
        if t.get("failure_label"):
            labels[t["failure_label"]] = labels.get(t["failure_label"], 0) + 1
    return {
        "tasks": n, "trials": trials, "passed": passed,
        "avg_pass_rate": round(sum(r["passes"] / r["k"] for r in results.values()) / n, 4),
        "pass_at_k": round(sum(r["pass_at_k"] for r in results.values()) / n, 4),
        "pass_pow_k": round(sum(r["pass_pow_k"] for r in results.values()) / n, 4),
        "ci95": [round(lo, 4), round(hi, 4)],
        "false_claims": sum(1 for t in flat if "claim" in t["grades"] and not t["grades"]["claim"]["pass"]),
        "ungrounded": sum(1 for t in flat if "grounded" in t["grades"] and not t["grades"]["grounded"]["pass"]),
        "blocked_attempts": sum(t.get("blocked_attempts", 0) for t in flat),
        "failure_labels": dict(sorted(labels.items(), key=lambda kv: -kv[1])),
    }
