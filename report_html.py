"""Build results/report.html: BEFORE (eyeballing replies) vs AFTER (graded by the harness)."""
import json
import sys
from html import escape
from pathlib import Path

CSS = """
body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f6f7f9;color:#1d2433}
header{background:#1d2433;color:#fff;padding:28px 40px}
header h1{margin:0 0 6px;font-size:26px} header p{margin:0;color:#b9c2d6}
main{max-width:1200px;margin:0 auto;padding:24px 40px 60px}
.cards{display:flex;gap:16px;flex-wrap:wrap;margin:20px 0}
.card{background:#fff;border-radius:10px;padding:16px 22px;box-shadow:0 1px 3px #0002;min-width:200px}
.card b{display:block;font-size:30px} .card span{color:#5b6579;font-size:13px}
.bad b{color:#c0392b} .good b{color:#1e8449}
h2{margin:34px 0 8px} p.note{color:#5b6579;margin:0 0 12px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px #0002}
th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #e8ebf0;font-size:14px}
th{background:#eef1f6;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
.ok{background:#d5f5e3;color:#1e8449} .no{background:#fadbd8;color:#a93226} .warn{background:#fdebd0;color:#b9770e}
tr.gap td{background:#fff8e6}
.reply{color:#394150;font-style:italic;max-width:360px} .mono{font-family:Consolas,monospace;font-size:12px;color:#394150}
"""


def build(results, title):
    rows, n, gaps = [], len(results), 0
    looks_fine = sum(1 for r in results.values() if r["trials"][0]["final"].strip())
    real_pass = sum(r["passes"] / r["k"] for r in results.values()) / n
    pow_k = sum(r["pass_pow_k"] for r in results.values()) / n
    for tid, r in results.items():
        t = r["trials"][0]
        reply = t["final"].strip() or "(no reply)"
        g = t["grades"]
        naive_ok = bool(t["final"].strip())
        real_ok = g["pass"]
        gap = naive_ok and not real_ok
        gaps += gap
        before = '<span class="pill ok">looks fine</span>' if naive_ok else '<span class="pill warn">empty</span>'
        after = (f'<span class="pill {"ok" if real_ok else "no"}">{"PASS" if real_ok else "FAIL"}</span> '
                 f'<span class="mono">{r["passes"]}/{r["k"]} runs</span>')
        why = escape(g["outcome"]["note"] if not g["outcome"]["pass"] else
                     ("" if g["trajectory"]["pass"] else g["trajectory"]["note"]))
        rows.append(f'<tr class="{"gap" if gap else ""}"><td><b>{escape(tid)}</b><br>'
                    f'<span class="mono">{escape(r["capability"])}</span></td>'
                    f'<td class="reply">{escape(reply[:240])}</td><td>{before}</td>'
                    f'<td>{after}</td><td class="mono">{why}</td></tr>')
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{escape(title)}</title>
<style>{CSS}</style></head><body>
<header><h1>{escape(title)}</h1><p>Same agent, same tasks. Before: judging by what it says. After: judging by what it did.</p></header>
<main>
<div class="cards">
<div class="card bad"><b>{looks_fine}/{n}</b><span>replies that "look fine" (before evals)</span></div>
<div class="card good"><b>{real_pass:.0%}</b><span>real pass rate (after evals)</span></div>
<div class="card"><b>{pow_k:.0%}</b><span>pass^k: every run succeeds</span></div>
<div class="card bad"><b>{gaps}</b><span>tasks that sounded fine but failed</span></div>
</div>
<h2>Before vs After, per task</h2>
<p class="note">Highlighted rows are where eyeballing the reply gives the wrong answer. "After" checks the shop's final state (refunds, escalations) and the tool-call order.</p>
<table><tr><th>Task</th><th>Agent's reply (first run)</th><th>Before: eyeball</th><th>After: harness</th><th>What actually happened</th></tr>
{''.join(rows)}</table>
</main></body></html>"""


if __name__ == "__main__":
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "results/results.json")
    title = sys.argv[2] if len(sys.argv) > 2 else "Agent eval: before vs after"
    out = src.with_name("report.html")
    out.write_text(build(json.loads(src.read_text()), title), encoding="utf-8")
    print(f"Wrote {out}")
