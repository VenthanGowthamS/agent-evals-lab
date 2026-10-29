# agent-evals-lab

A small, local-first harness for **evaluating tool-using LLM agents**, built around one question:
*"The agent said it did the job. Did it actually?"*

A customer-support agent (runs on a small local LLM via [Ollama](https://ollama.com)) can look up orders,
issue refunds and escalate to a human. The harness runs it on a task set, resets the environment before
every run, and grades what really happened in the system, not just what the model said.

## What it measures

| Dimension | How it's graded | Why |
|---|---|---|
| **Outcome** | Check end state (refund rows, escalations) in the environment | Many paths are valid; grade where it ended up |
| **Trajectory** | Inspect the tool-call transcript (e.g. lookup must precede refund; no loops) | Catches right answer reached unsafely |
| **Reliability** | `k` trials per task: **pass@k** (any run succeeds) vs **pass^k** (all runs succeed) | A 75% agent only gets 3/3 right ~42% of the time |
| **Efficiency** | Tool calls and latency per task | Cost and speed matter in production |
| **Restraint / safety** | Tasks where the right move is *not* to act: out-of-policy refunds, fake approvals, prompt injection, missing info | Otherwise you only test that the agent acts |

Code graders are used wherever possible. `evals/graders.py` also has an LLM-judge template (one dimension,
rubric, `UNKNOWN` allowed) for open-ended parts like tone; calibrate it against human labels before trusting it.

## Quick start

```bash
# 1. Install Ollama (https://ollama.com), then pull a small model that supports tool calling
ollama pull qwen2.5:3b          # or llama3.2:3b

# 2. Python deps
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. Sanity-check the harness itself (no LLM needed)
python run_evals.py --agent mock --k 5

# 4. Evaluate the real local model
python run_evals.py --agent ollama --model qwen2.5:3b --k 5
```

Outputs: `results/report.md` (summary tables) and `results/results.json` (full transcripts: **read them**,
scores alone can hide broken graders).

## Repo layout

```
agent/env.py         mock store: orders, refund policy, tools; reset per trial
agent/agent.py       Ollama tool-calling loop + a seeded mock agent for testing graders
tasks/tasks.jsonl    12 tasks, each labelled with the capability it tests
evals/graders.py     outcome / trajectory / efficiency graders + LLM-judge template
run_evals.py         runs k trials per task, computes pass@k, pass^k, per-capability table
```

## Results

_Paste your latest `results/report.md` table here after running against a real model._

## Findings

_Fill in after reading transcripts: where does the small model fail (skips lookup? refunds on fake approval?),
and what changed when you tightened the system prompt or tool descriptions?_

## Roadmap

- [ ] Grow tasks from 12 to 30-50, sourced from real failure patterns
- [ ] Compare models (3B vs 7B/8B) on the same task set
- [ ] Calibrate the LLM judge against human labels (agreement rate)
- [ ] Add multi-turn tasks (ask for missing order id, then act)
- [ ] CI run on every change to prompts or tools (regression evals)
