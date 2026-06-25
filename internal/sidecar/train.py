"""
LoRA / QLoRA training sidecar.

FastAPI server that the Go app drives to spawn supervised fine-tuning
jobs. Each job runs in a background thread and writes status to a
per-job JSON file the Go side polls.

Endpoints:

    GET  /health                  — readiness
    POST /train/start             — kick off a job
    GET  /train/jobs              — list known jobs
    GET  /train/jobs/{job_id}     — single job state
    POST /train/jobs/{job_id}/cancel
    GET  /train/jobs/{job_id}/log — log tail (last N lines)

Dataset format (JSONL):

    {"messages": [
       {"role": "user",      "content": "…"},
       {"role": "assistant", "content": "…"}
    ]}

That's the standard Hugging Face chat format. TRL's SFTTrainer applies
the model's chat template automatically.

Output goes to ~/.blueprint/lora/<job_id>/ which contains:
   - meta.json     — job state + final metrics
   - adapter/      — the LoRA adapter files (loadable by llama.cpp + vLLM)
   - log.txt       — full training log
"""

from __future__ import annotations

import sys
import os
import json
import time
import uuid
import threading
import logging
import traceback
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn


log = logging.getLogger("blueprint.train")
log.setLevel(logging.INFO)


app = FastAPI(title="Blueprint LoRA training sidecar")


# ─── State ────────────────────────────────────────────────────────────

# In-memory job registry. Persisted to disk on every transition.
JOBS: dict[str, "JobState"] = {}
JOBS_LOCK = threading.Lock()


def jobs_root() -> Path:
    """~/.blueprint/lora/jobs/."""
    home = Path(os.environ.get("BLUEPRINT_HOME") or Path.home() / ".blueprint")
    p = home / "lora" / "jobs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def job_dir(job_id: str) -> Path:
    p = jobs_root() / job_id
    p.mkdir(parents=True, exist_ok=True)
    return p


# ─── Request / response schemas ───────────────────────────────────────

class TrainStartRequest(BaseModel):
    base_model: str        # HF identifier, e.g. "meta-llama/Llama-3.2-3B-Instruct"
    dataset_path: str      # absolute path to JSONL
    output_label: str = "" # user-facing label; defaults to job_id
    epochs: float = 3.0
    learning_rate: float = 2e-4
    lora_rank: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: list[str] = ["q_proj", "k_proj", "v_proj", "o_proj"]
    batch_size: int = 2
    grad_accum_steps: int = 4
    max_seq_length: int = 2048
    use_4bit: bool = True   # QLoRA on the base
    use_fp16: bool = True


class JobState(BaseModel):
    job_id: str
    label: str = ""
    base_model: str = ""
    dataset_path: str = ""
    output_dir: str = ""
    status: str = "pending"   # pending | running | done | failed | cancelled
    started_at_ms: int = 0
    finished_at_ms: int = 0
    current_step: int = 0
    total_steps: int = 0
    last_loss: float = 0.0
    last_error: str = ""


# ─── Persistence helpers ──────────────────────────────────────────────

def write_state(state: JobState):
    """Persist meta.json for the job so the Go side can poll without us."""
    path = job_dir(state.job_id) / "meta.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(state.dict(), f, indent=2)


def load_states_from_disk():
    """Repopulate JOBS from on-disk meta.json files. Called on startup so a
    sidecar restart doesn't lose visibility of past jobs."""
    for d in jobs_root().iterdir():
        if not d.is_dir():
            continue
        meta = d / "meta.json"
        if not meta.exists():
            continue
        try:
            with meta.open("r", encoding="utf-8") as f:
                data = json.load(f)
            st = JobState(**data)
            JOBS[st.job_id] = st
        except Exception:
            log.exception("load meta %s", meta)


# ─── Training worker ──────────────────────────────────────────────────

def run_training(state: JobState, req: TrainStartRequest, cancel_event: threading.Event):
    """The actual training loop. Runs in a background thread."""

    log_path = job_dir(state.job_id) / "log.txt"
    log_file = log_path.open("w", encoding="utf-8", buffering=1)

    def emit(line: str):
        ts = time.strftime("%H:%M:%S")
        log_file.write(f"{ts}  {line}\n")
        log.info("[%s] %s", state.job_id[:8], line)

    try:
        emit("loading transformers + peft + datasets …")
        # Local imports so the sidecar boots fast for /health.
        import torch
        from transformers import (
            AutoTokenizer,
            AutoModelForCausalLM,
            BitsAndBytesConfig,
        )
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from trl import SFTTrainer, SFTConfig
        from datasets import load_dataset

        emit(f"loading tokenizer for {req.base_model}")
        tokenizer = AutoTokenizer.from_pretrained(req.base_model, use_fast=True)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        emit(f"loading base model (4bit={req.use_4bit})")
        bnb_config = None
        if req.use_4bit:
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            )
        model = AutoModelForCausalLM.from_pretrained(
            req.base_model,
            quantization_config=bnb_config,
            torch_dtype=torch.bfloat16 if req.use_fp16 else torch.float32,
            device_map="auto",
        )
        if req.use_4bit:
            model = prepare_model_for_kbit_training(model)

        emit(f"applying LoRA rank={req.lora_rank} alpha={req.lora_alpha}")
        lora_config = LoraConfig(
            r=req.lora_rank,
            lora_alpha=req.lora_alpha,
            target_modules=req.target_modules,
            lora_dropout=req.lora_dropout,
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, lora_config)
        trainable, total = 0, 0
        for p in model.parameters():
            total += p.numel()
            if p.requires_grad:
                trainable += p.numel()
        emit(f"trainable params: {trainable:,} / {total:,} ({100*trainable/total:.2f}%)")

        emit(f"loading dataset from {req.dataset_path}")
        ds = load_dataset("json", data_files=req.dataset_path, split="train")

        output_dir = str(job_dir(state.job_id) / "adapter")
        state.output_dir = output_dir
        write_state(state)

        emit(f"starting SFT training, epochs={req.epochs}, lr={req.learning_rate}")
        sft_config = SFTConfig(
            output_dir=output_dir,
            num_train_epochs=req.epochs,
            per_device_train_batch_size=req.batch_size,
            gradient_accumulation_steps=req.grad_accum_steps,
            learning_rate=req.learning_rate,
            max_seq_length=req.max_seq_length,
            logging_steps=10,
            save_strategy="epoch",
            bf16=req.use_fp16,
            report_to=[],  # disable wandb / tensorboard
        )

        # Hook step events from the Trainer so we update meta.json live.
        from transformers import TrainerCallback

        class ProgressCallback(TrainerCallback):
            def on_train_begin(self, args, st, control, **kw):
                state.status = "running"
                state.started_at_ms = int(time.time() * 1000)
                state.total_steps = st.max_steps
                write_state(state)
                emit(f"on_train_begin — max_steps={st.max_steps}")

            def on_log(self, args, st, control, logs=None, **kw):
                if cancel_event.is_set():
                    control.should_training_stop = True
                    return
                state.current_step = st.global_step
                if logs and "loss" in logs:
                    state.last_loss = float(logs["loss"])
                write_state(state)

            def on_step_end(self, args, st, control, **kw):
                if cancel_event.is_set():
                    control.should_training_stop = True

        trainer = SFTTrainer(
            model=model,
            args=sft_config,
            train_dataset=ds,
            tokenizer=tokenizer,
            callbacks=[ProgressCallback()],
        )
        trainer.train()

        if cancel_event.is_set():
            state.status = "cancelled"
            emit("cancelled by user")
        else:
            emit("training finished — saving adapter")
            trainer.save_model(output_dir)
            state.status = "done"

        state.finished_at_ms = int(time.time() * 1000)
        write_state(state)
        emit("done")

    except Exception as exc:  # noqa: BLE001
        emit(f"FAILED: {exc!r}")
        emit(traceback.format_exc())
        state.status = "failed"
        state.last_error = str(exc)
        state.finished_at_ms = int(time.time() * 1000)
        write_state(state)
    finally:
        log_file.close()


# Active cancellation flags keyed by job_id.
CANCEL_EVENTS: dict[str, threading.Event] = {}


# ─── HTTP handlers ────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True, "jobs_active": sum(1 for j in JOBS.values() if j.status in ("pending", "running"))}


@app.post("/train/start")
def train_start(req: TrainStartRequest):
    if not Path(req.dataset_path).exists():
        raise HTTPException(400, f"dataset not found: {req.dataset_path}")
    job_id = uuid.uuid4().hex[:12]
    state = JobState(
        job_id=job_id,
        label=req.output_label or job_id,
        base_model=req.base_model,
        dataset_path=req.dataset_path,
        status="pending",
    )
    write_state(state)
    with JOBS_LOCK:
        JOBS[job_id] = state

    cancel_event = threading.Event()
    CANCEL_EVENTS[job_id] = cancel_event
    th = threading.Thread(
        target=run_training,
        args=(state, req, cancel_event),
        daemon=True,
        name=f"train-{job_id}",
    )
    th.start()
    return {"job_id": job_id, "status": "pending"}


@app.get("/train/jobs")
def list_jobs():
    return {"jobs": [j.dict() for j in JOBS.values()]}


@app.get("/train/jobs/{job_id}")
def get_job(job_id: str):
    j = JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j.dict()


@app.post("/train/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    ev = CANCEL_EVENTS.get(job_id)
    if not ev:
        raise HTTPException(404, "job not found or already finished")
    ev.set()
    return {"ok": True, "job_id": job_id}


@app.get("/train/jobs/{job_id}/log")
def get_log(job_id: str, lines: int = 200):
    p = job_dir(job_id) / "log.txt"
    if not p.exists():
        return {"lines": []}
    out = p.read_text(encoding="utf-8").splitlines()
    return {"lines": out[-max(1, lines):]}


def main():
    if len(sys.argv) < 2:
        print("usage: train.py PORT", file=sys.stderr)
        sys.exit(2)
    port = int(sys.argv[1])

    home = os.environ.get("BLUEPRINT_HOME") or os.path.expanduser("~/.blueprint")
    os.environ.setdefault("HF_HOME", os.path.join(home, "hf-cache"))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    load_states_from_disk()
    log.info("starting LoRA training sidecar on 127.0.0.1:%d", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
