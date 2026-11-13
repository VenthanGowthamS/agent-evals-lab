# Re-run, 13 Nov 2026

The same model (`qwen2.5:3b`), the same 12 scenarios and the same k=5 as the recorded run in `results/`,
run again with the v2 runner to check run-to-run variation.

- Where: a cloud Linux machine, CPU only, Ollama 0.40.16 (the recorded run was on my laptop).
- Command: `python run_evals.py --agent ollama --model qwen2.5:3b --k 5 --seed 1 --out results/rerun-2026-11-13`
- `--seed` only affects the mock agent; the model's own sampling is not seeded, so every run differs a little.

See the comparison in the main README, section "Same model, run again".
