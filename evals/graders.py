"""Graders. Code-based first: cheap, deterministic, repeatable."""


def grade_outcome(env, task):
    """Did the system end in the right STATE? (not: did it say the right words)"""
    exp = task["expected"]
    want = sorted((r["order_id"], r["amount"]) for r in exp.get("refunds", []))
    got = sorted((r["order_id"], r["amount"]) for r in env.refunds)
    ok = want == got
    if "escalated" in exp:
        ok = ok and (bool(env.escalations) == exp["escalated"])
    return ok, f"refunds want={want} got={got} escalated={bool(env.escalations)}"


def grade_trajectory(env, task):
    """Right tools in a sane order? Only enforce order where it matters (lookup before refund)."""
    names = [c[0] for c in env.calls]
    for i, (name, args) in enumerate(env.calls):
        if name == "issue_refund":
            looked_up = any(n == "lookup_order" and a.get("order_id") == args.get("order_id")
                            for n, a in env.calls[:i])
            if not looked_up:
                return False, "refund issued without looking the order up first"
    if len(names) != len(set(map(str, env.calls))):
        return False, "repeated identical tool call (loop)"
    return True, "ok"


def grade_efficiency(env, task):
    steps = len(env.calls)
    return steps <= task.get("max_steps", 4), f"{steps} tool calls"


GRADERS = {"outcome": grade_outcome, "trajectory": grade_trajectory, "efficiency": grade_efficiency}


def grade_all(env, task):
    res = {}
    for name, fn in GRADERS.items():
        ok, note = fn(env, task)
        res[name] = {"pass": ok, "note": note}
    # A trial 'passes' only if outcome AND trajectory pass; efficiency is reported separately.
    res["pass"] = res["outcome"]["pass"] and res["trajectory"]["pass"]
    return res


# ---- optional LLM judge for open-ended parts (tone, helpfulness of the final reply) ----
JUDGE_RUBRIC = """You are grading a customer-support reply on ONE dimension: {dimension}.
Rubric: {rubric}
Reply to grade:
---
{reply}
---
Answer with exactly one word: PASS, FAIL, or UNKNOWN (use UNKNOWN if you cannot tell)."""


def llm_judge(reply, dimension, rubric, model="qwen2.5:3b"):
    import ollama
    out = ollama.chat(model=model, messages=[{"role": "user", "content": JUDGE_RUBRIC.format(
        dimension=dimension, rubric=rubric, reply=reply)}], options={"temperature": 0})
    verdict = out["message"]["content"].strip().upper()
    return verdict if verdict in ("PASS", "FAIL", "UNKNOWN") else "UNKNOWN"
