"""Re-grade a saved run with the transcript graders, offline. No model needed.

  python regrade.py                       # results/results.json in place
  python regrade.py --check               # only verify existing grades are untouched

Existing outcome / trajectory / efficiency grades and the overall pass are never changed.
"""
import argparse
import copy
import json
from pathlib import Path

from evals.transcript_graders import grade_transcript


def regrade(results, tasks):
    for tid, r in results.items():
        for t in r["trials"]:
            before = copy.deepcopy({k: t["grades"][k] for k in ("outcome", "trajectory", "efficiency", "pass")})
            t.update(grade_transcript(t["transcript"], t.get("final", ""), tasks[tid], t["grades"]))
            after = {k: t["grades"][k] for k in ("outcome", "trajectory", "efficiency", "pass")}
            assert before == after, f"existing grade changed for {tid}"
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results/results.json")
    ap.add_argument("--tasks", default="tasks/tasks.jsonl")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--agent", default="ollama", help="label for the rebuilt report.md")
    ap.add_argument("--model", default="qwen2.5:3b")
    a = ap.parse_args()
    tasks = {json.loads(l)["id"]: json.loads(l) for l in Path(a.tasks).read_text().splitlines() if l.strip()}
    results = regrade(json.loads(Path(a.results).read_text()), tasks)
    if not a.check:
        Path(a.results).write_text(json.dumps(results, indent=2, default=str))
        from run_evals import write_report
        a.k = next(iter(results.values()))["k"]
        write_report(results, a, Path(a.results).parent)
    for tid, r in results.items():
        claim = sum(not t["grades"]["claim"]["pass"] for t in r["trials"])
        grounded = sum(not t["grades"]["grounded"]["pass"] for t in r["trials"])
        labels = sorted({t["failure_label"] for t in r["trials"] if t["failure_label"]})
        print(f"{tid:26s} false claims {claim}/{r['k']}  ungrounded {grounded}/{r['k']}  {', '.join(labels)}")


if __name__ == "__main__":
    main()
