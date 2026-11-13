"""Run every task k times, grade outcome + trajectory + efficiency, report pass@k and pass^k.

  python run_evals.py --agent ollama --model qwen2.5:3b --k 5
  python run_evals.py --agent mock --k 5          # no LLM needed; validates the harness
  python run_evals.py --agent mock --out runs/try1   # keep results/ (the recorded baseline) untouched
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

from evals.stats import wilson
from harness.runner import run_suite, summarize


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", choices=["ollama", "mock"], default="mock")
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--noise", type=float, default=0.25, help="mock agent mistake rate")
    ap.add_argument("--tasks", default="tasks/tasks.jsonl")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="results", help="folder for report.md, report.html and results.json")
    args = ap.parse_args()

    results = {}
    cfg = {k: getattr(args, k) for k in ("agent", "model", "k", "noise", "tasks", "seed")}
    for ev in run_suite(cfg):
        if ev["type"] == "task_finished":
            r = ev["record"]
            print(f"{ev['task_id']:26s} {r['passes']}/{args.k}  pass@k={r['pass_at_k']!s:5}  pass^k={r['pass_pow_k']!s:5}")
        elif ev["type"] == "run_finished":
            results = ev["results"]

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(results, indent=2, default=str))
    write_report(results, args, out)
    from report_html import build
    (out / "report.html").write_text(build(results, f"Agent eval: {args.agent} ({args.model if args.agent == 'ollama' else 'mock'}), k={args.k}"), encoding="utf-8")
    print(f"Wrote {out}/report.html")


def write_report(results, args, out=Path("results")):
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
    lines += extra_sections(results)
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print(f"\nWrote {out}/report.md and {out}/results.json")


def extra_sections(results):
    """v2 sections: uncertainty, reply-versus-reality, right-reason restraint, failure labels."""
    s = summarize(results)
    lines = ["", "## How sure are these numbers? (95% Wilson interval)", "",
             f"Overall: {s['passed']}/{s['trials']} trials passed, so the true pass rate is plausibly "
             f"between {s['ci95'][0]:.0%} and {s['ci95'][1]:.0%}.", "",
             "| Task | Passes | Plausible range |", "|---|---|---|"]
    for tid, r in results.items():
        lo, hi = wilson(r["passes"], r["k"])
        lines.append(f"| {tid} | {r['passes']}/{r['k']} | {lo:.0%} to {hi:.0%} |")
    lines += ["", "## Extra checks (reported beside the pass rule, not part of it)", "",
              "| Task | Reply claims an action that never happened | Declined without looking the order up | Refund attempts the shop blocked |",
              "|---|---|---|---|"]
    for tid, r in results.items():
        claim = sum(not t["grades"]["claim"]["pass"] for t in r["trials"])
        ungr = sum(not t["grades"]["grounded"]["pass"] for t in r["trials"])
        blocked = sum(t.get("blocked_attempts", 0) for t in r["trials"])
        lines.append(f"| {tid} | {claim}/{r['k']} | {ungr}/{r['k']} | {blocked} |")
    lines += ["", "## How the failed trials failed", "", "| Failure | Trials |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in s["failure_labels"].items()] or ["| (none) | 0 |"]
    return lines


if __name__ == "__main__":
    main()
