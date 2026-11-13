"""Graders that read the transcript, so they also work offline on results.json.

  claim     - does the final reply claim an action that never happened?
  grounded  - when the agent declined, had it looked the order up first?
  label     - for a failed trial, a short name for HOW it failed.

They are reported beside outcome / trajectory / efficiency and do not change
the overall pass rule.
"""
import re

# Completed-action wording only. "I can process the refund" is an offer, not a claim.
_NEG = r"(?:not|n't|unable|cannot|can't|no longer|won't|never)"
REFUND_CLAIMS = [
    r"refund\b[^.!?]{0,60}\b(?:has|have) been (?:successfully )?(?:issued|processed|completed|made|approved|initiated)",
    r"\b(?:has|have) been (?:successfully )?refunded",
    r"\brefunded successfully",
    r"\bI(?:'ve| have)? (?:successfully )?(?:issued|processed|completed|initiated) (?:a|the|your|an?)\b[^.!?]{0,40}refund",
    r"\bI(?:'ve| have) refunded",
    r"refund\b[^.!?]{0,60}\b(?:was|is) (?:successfully )?(?:issued|processed|completed)\b",
    r"\bsuccessfully (?:issued|processed) (?:a|the|your)\b[^.!?]{0,40}refund",
    r"\b(?:has|have) been (?:successfully )?processed for a refund",
]
ESCALATION_CLAIMS = [
    r"\b(?:has|have) been (?:escalated|transferred|handed over|forwarded)",
    r"\bI(?:'ve| have)? (?:escalated|transferred|handed|forwarded)\b",
    r"\b(?:escalated|transferred) (?:your|this|the) (?:case|issue|request|matter)",
]


def facts(transcript, final=""):
    """Rebuild what happened from the transcript: calls with results, refunds that landed, escalations."""
    calls, pending = [], []
    for m in transcript:
        if m.get("role") == "assistant":
            for c in m.get("tool_calls") or []:
                pending.append({"name": c["name"], "args": c.get("args") or {}, "result": None})
                calls.append(pending[-1])
        elif m.get("role") == "tool":
            for c in pending:
                if c["result"] is None and c["name"] == m.get("name"):
                    c["result"] = m.get("content")
                    break
    ok = lambda c: isinstance(c["result"], dict) and c["result"].get("ok") is True
    return {
        "calls": calls,
        "refunds": [c for c in calls if c["name"] == "issue_refund" and ok(c)],
        "blocked": [c for c in calls if c["name"] == "issue_refund" and not ok(c)],
        "escalations": [c for c in calls if c["name"] == "escalate_to_human" and ok(c)],
        "final": final or "",
    }


def _claims(text, patterns):
    """First sentence that states a completed action without a negation, or None."""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if re.search(_NEG, sentence, re.I):
            continue
        if any(re.search(p, sentence, re.I) for p in patterns):
            return sentence.strip()
    return None


def grade_claim(f, task):
    """Fail when the reply says a refund or hand-over happened and the shop's records say it did not."""
    said_refund = _claims(f["final"], REFUND_CLAIMS)
    if said_refund and not f["refunds"]:
        return False, f'says refunded, but no refund exists: "{said_refund[:90]}"'
    said_esc = _claims(f["final"], ESCALATION_CLAIMS)
    if said_esc and not f["escalations"]:
        return False, f'says escalated, but no hand-over exists: "{said_esc[:90]}"'
    if f["refunds"] and not said_refund:
        return True, "refund made; reply does not clearly confirm it"
    return True, "reply matches what happened"


def grade_grounded(f, task):
    """A 'no' only counts if the agent checked first. Doing nothing must not score as restraint."""
    oid = task.get("order_id")
    exp = task.get("expected", {})
    if not oid or exp.get("refunds") or exp.get("escalated"):
        return True, "not applicable"
    looked = any(c["name"] == "lookup_order" and c["args"].get("order_id") == oid for c in f["calls"])
    if looked:
        return True, "looked the order up before deciding"
    if f["escalations"]:
        return True, "handed over without deciding"
    return False, "declined or answered without looking the order up"


def failure_label(f, task, grades):
    """One short name for how a failed trial failed. None when it passed."""
    if grades.get("pass"):
        return None
    exp = task.get("expected", {})
    want = exp.get("refunds", [])
    names = [c["name"] for c in f["calls"]]
    if not grades["trajectory"]["pass"]:
        if "loop" in grades["trajectory"]["note"]:
            return "looped"
        return "refund_attempt_without_lookup"
    if want:
        if not f["calls"]:
            return "no_action"
        if "issue_refund" not in names:
            return "stopped_after_lookup" if "lookup_order" in names else "no_refund_attempt"
        if f["blocked"] and not f["refunds"]:
            return "refund_blocked_by_shop"
        return "wrong_amount"
    if f["refunds"]:
        return "refund_outside_policy"
    if "escalated" in exp and bool(f["escalations"]) != exp["escalated"]:
        return "missed_escalation" if exp["escalated"] else "needless_escalation"
    return "other"


TRANSCRIPT_GRADERS = {"claim": grade_claim, "grounded": grade_grounded}


def grade_transcript(transcript, final, task, grades):
    """Add the transcript graders and the failure label to an existing grades dict. Returns extras."""
    f = facts(transcript, final)
    for name, fn in TRANSCRIPT_GRADERS.items():
        ok, note = fn(f, task)
        grades[name] = {"pass": ok, "note": note}
    return {"failure_label": failure_label(f, task, grades), "blocked_attempts": len(f["blocked"])}
