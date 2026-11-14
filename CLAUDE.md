# Working rules for this repo

This repo is being built test-first. The plan is `docs/PLAN-v3.md`. Read it before changing anything.

## The loop (one item at a time, in plan order)

1. `python scripts/tdd_status.py` shows what is red and names the next item.
2. Read that item in `docs/PLAN-v3.md` and its test file `tests/test_v3_<n>_*.py`. The test file is the spec.
3. Run it and watch it fail: `python -m unittest tests.test_v3_<n>_<name> -v`
4. Write the smallest code that makes it pass. Touch only the files the plan lists for that item.
5. Run everything: `python scripts/tdd_status.py --check` must exit 0, and the item must show GREEN.
6. Add the test module name to `tests/v3_green.txt`, tick the item in `docs/PLAN-v3.md`.
7. Commit: `green: v3 item <n> - <what now works>`. One item per commit. Then stop and report.

## Rules

- Never edit a `tests/test_v3_*.py` file to make it pass, and never delete or skip a test.
  If a test looks wrong or two tests contradict each other, stop and ask the user.
- Never change `results/results.json` or anything under `results/` by hand. Those are recorded runs.
  The numbers 43/60 and 47/60 must stay true.
- The old pass rule (`grades["pass"]` = outcome and trajectory) never changes. New checks are reported beside it.
- `agent/env.py` ORDERS and `web/policy.js` ORDERS must stay identical (a test checks it).
- No new dependencies. Standard library only, except what is already in requirements.txt.
- Python: keep the existing style (short functions, a one-line docstring that says why).
- Do not push to `main`. Work on the `v3-evals` branch.
- No model is needed for any test. Do not call Ollama in tests.

## Commands

    python scripts/tdd_status.py                         # red / green board
    python -m unittest tests.test_v3_3_tool_injection -v # one item
    python -m unittest discover -s tests -p "test_[!v]*.py"   # the old 44 tests
    python run_evals.py --agent mock --k 5 --out runs/try     # full mock run, no model
    python regrade.py --check                            # recorded baseline untouched
    uvicorn api.main:app                                 # then open http://localhost:8000
