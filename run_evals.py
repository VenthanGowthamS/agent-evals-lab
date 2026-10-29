"""Run every task k times, grade outcome + trajectory + efficiency, report pass@k and pass^k.

  python run_evals.py --agent ollama --model qwen2.5:3b --k 5
  python run_evals.py --agent mock --k 5          # no LLM needed; validates the harness
"""
import argparse
import json
import random
import time
from collections import defaultdict
from pathlib import Path

from agent.env import Env
from agent.agent import run_ollama, run_mock
from evals.graders import grade_all


def load_tasks(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def run_trial(task, args, rng):
    env = Env()          # fresh environment every trial: runs cannot contaminate each other
    t0 = time.time()
    if args.agent == "ollama":
        transcript, final = run_ollama(env, task["prompt"], model=args.model)
    else:
        transcript, final = run_mock(env, task["prompt"], task=task, noise=args.noise, rng=rng)
    grades = grade_all(env, task)
    return {"grades": grades, "transcript": transcript, "final": final,
            "latency_s": round(time.time() - t0, 2), "tool_calls": len(env.calls)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", choices=["ollama", "mock"], default="mock")
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--noise", type=float, default=0.25, help="mock agent mistake rate")
    ap.add_argument("--tasks", default="tasks/tasks.jsonl")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    results = {}
    for task in load_tasks(args.tasks):
        trials = [run_trial(task, args, rng) for _ in range(args.k)]
        passes = [t["grades"]["pass"] for t in trials]
        results[task["id"]] = {
            "capability": task["capability"],
            "passes": sum(passes), "k": args.k,
            "pass_at_k": any(passes),          # at least one run succeeded
            "pass_pow_k": all(passes),         # every run succeeded (what users feel)
            "avg_tool_calls": round(sum(t["tool_calls"] for t in trials) / args.k, 2),
            "avg_latency_s": round(sum(t["latency_s"] for t in trials) / args.k, 2),
            "trials": trials,
        }
        r = results[task["id"]]
        print(f"{task['id']:26s} {r['passes']}/{args.k}  pass@k={r['pass_at_k']!s:5}  pass^k={r['pass_pow_k']!s:5}")

    Path("results").mkdir(exist_ok=True)
    Path("results/results.json").write_text(json.dumps(results, indent=2, default=str))
    write_report(results, args)


def write_report(results, args):
    n = len(results)
    avg = sum(r["passes"] / r["k"] for r in results.values()) / n
    pk = sum(r["pass_at_k"] for r in results.values()) / n
    ppk = sum(r["pass_pow_k"] for r in results.values()) / n
    by_cap = defaultdict(list)
    for r in results.values():
        by_cap[r["capability"]].append(r["passes"] / r["k"])
    lines = [f"# Eval report: `{args.agent}` ({args.model if args.agent == 'ollama' else 'mock'}), k={args.k}", "",
             "| Metric | Value |", "|---|---|",
             f"| Avg per-trial pass rate | {avg:.0%} |",
             f"| pass@{args.k} (any run succeeds) | {pk:.0%} |",
             f"| pass^{args.k} (all runs succeed) | {ppk:.0%} |", "",
             "## By capability", "", "| Capability | Pass rate |", "|---|---|"]
    lines += [f"| {c} | {sum(v) / len(v):.0%} |" for c, v in sorted(by_cap.items())]
    lines += ["", "## Per task", "", "| Task | Capability | Passes | pass^k | Avg tool calls |", "|---|---|---|---|---|"]
    lines += [f"| {tid} | {r['capability']} | {r['passes']}/{r['k']} | {'yes' if r['pass_pow_k'] else 'no'} | {r['avg_tool_calls']} |"
              for tid, r in results.items()]
    lines += ["", "## Failures to read (transcripts in results/results.json)", ""]
    for tid, r in results.items():
        bad = [t for t in r["trials"] if not t["grades"]["pass"]]
        if bad:
            g = bad[0]["grades"]
            lines.append(f"- **{tid}**: outcome: {g['outcome']['note']} | trajectory: {g['trajectory']['note']}")
    Path("results/report.md").write_text("\n".join(lines) + "\n")
    print("\nWrote results/report.md and results/results.json")


if __name__ == "__main__":
    main()
