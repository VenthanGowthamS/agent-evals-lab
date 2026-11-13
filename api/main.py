"""FastAPI service around the harness.

  uvicorn api.main:app --reload      then open http://localhost:8000

Starts eval runs, streams their events (server-sent events) and serves the 3D replay page.
Set EVALS_MOCK_ONLY=1 where no local model exists (for example in the cloud): the Ollama agent is then refused.
"""
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from harness.runner import load_tasks, run_suite, summarize

ROOT = Path(__file__).resolve().parent.parent
RUNS_DIR = ROOT / "runs"
BASELINE = ROOT / "results" / "results.json"
TASKS = ROOT / "tasks" / "tasks.jsonl"

app = FastAPI(title="agent-evals-lab", version="2.0")


class RunRequest(BaseModel):
    agent: Literal["mock", "ollama"] = "mock"
    model: str = "qwen2.5:3b"
    k: int = Field(5, ge=1, le=10)
    noise: float = Field(0.25, ge=0, le=1)
    seed: int = 0
    task_ids: Optional[List[str]] = None


class Run:
    def __init__(self, run_id, config):
        self.id, self.config = run_id, config
        self.events, self.results, self.summary = [], None, None
        self.status, self.error, self.started = "running", None, time.time()
        self.cond = threading.Condition()

    def add(self, ev):
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()


RUNS = {}
LOCK = threading.Lock()


def _ollama_up():
    try:
        import ollama
        ollama.list()
        return True
    except Exception:
        return False


def _execute(run):
    try:
        for ev in run_suite({**run.config, "tasks": str(TASKS), "live_steps": True}):
            if ev["type"] == "run_finished":
                run.results, run.summary = ev["results"], ev["summary"]
                RUNS_DIR.mkdir(exist_ok=True)
                (RUNS_DIR / f"{run.id}.json").write_text(json.dumps(
                    {"config": run.config, "summary": run.summary, "results": run.results}, indent=2, default=str))
                ev = {"type": "run_finished", "summary": ev["summary"]}
            elif ev["type"] == "task_finished":
                ev = {"type": "task_finished", "task_id": ev["task_id"],
                      "record": {k: v for k, v in ev["record"].items() if k != "trials"}}
            run.add(ev)
        run.status = "finished"
    except Exception as e:  # surface the failure to anyone following the stream
        run.status, run.error = "failed", str(e)
        run.add({"type": "run_failed", "error": str(e)})
    finally:
        with run.cond:
            run.cond.notify_all()


def _saved():
    out = {}
    if BASELINE.exists():
        res = json.loads(BASELINE.read_text())
        out["baseline"] = {"config": {"agent": "ollama", "model": "qwen2.5:3b", "k": next(iter(res.values()))["k"]},
                           "results": res, "summary": summarize(res)}
    for f in sorted(BASELINE.parent.glob("*/results.json")):      # recorded re-runs, e.g. results/rerun-2026-11-13/
        res = json.loads(f.read_text())
        out[f.parent.name] = {"config": {"agent": "ollama", "model": "qwen2.5:3b", "k": next(iter(res.values()))["k"]},
                              "results": res, "summary": summarize(res)}
    for f in sorted(RUNS_DIR.glob("*.json")) if RUNS_DIR.exists() else []:
        out[f.stem] = json.loads(f.read_text())
    return out


@app.get("/api/health")
def health():
    mock_only = os.environ.get("EVALS_MOCK_ONLY") == "1"
    return {"ok": True, "mock_only": mock_only, "ollama": False if mock_only else _ollama_up(),
            "running": any(r.status == "running" for r in RUNS.values())}


@app.get("/api/tasks")
def tasks():
    return load_tasks(TASKS)


@app.get("/api/runs")
def runs():
    items = [{"id": rid, "status": "finished", "config": d.get("config"), "summary": d.get("summary")}
             for rid, d in _saved().items()]
    items += [{"id": r.id, "status": r.status, "config": r.config, "summary": r.summary}
              for r in RUNS.values() if r.status != "finished"]
    return items


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    saved = _saved()
    if run_id in saved:
        return saved[run_id]["results"]
    if run_id in RUNS:
        raise HTTPException(409, f"run {run_id} is {RUNS[run_id].status}; follow /api/runs/{run_id}/events")
    raise HTTPException(404, "no such run")


@app.post("/api/runs", status_code=202)
def start_run(req: RunRequest):
    if req.agent == "ollama" and os.environ.get("EVALS_MOCK_ONLY") == "1":
        raise HTTPException(403, "this deployment runs the mock agent only")
    known = {t["id"] for t in load_tasks(TASKS)}
    if req.task_ids and not set(req.task_ids) <= known:
        raise HTTPException(422, f"unknown task ids: {sorted(set(req.task_ids) - known)}")
    with LOCK:
        if any(r.status == "running" for r in RUNS.values()):
            raise HTTPException(409, "a run is already in progress; one at a time")
        run = Run(time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6], req.model_dump())
        RUNS[run.id] = run
    threading.Thread(target=_execute, args=(run,), daemon=True).start()
    return {"id": run.id, "status": "running", "events": f"/api/runs/{run.id}/events"}


@app.get("/api/runs/{run_id}/events")
def run_events(run_id: str):
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "no live event stream for this run (only runs started since the server came up)")

    def stream():
        i = 0
        while True:
            with run.cond:
                while i >= len(run.events) and run.status == "running":
                    run.cond.wait(timeout=15)
                batch, i = run.events[i:], len(run.events)
                done = run.status != "running" and i >= len(run.events)
            for ev in batch:
                yield f"event: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
            if done:
                return
            if not batch:
                yield ": keep-alive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.get("/")
def home():
    return RedirectResponse("/web/")


app.mount("/results", StaticFiles(directory=ROOT / "results"), name="results")
app.mount("/web", StaticFiles(directory=ROOT / "web", html=True), name="web")
