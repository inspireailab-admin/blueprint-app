"""
LLMLingua prompt compression sidecar.

Blueprint spawns this script after the user installs the LLMLingua
feature. It runs a tiny FastAPI server on localhost:<PORT> exposing:

    GET  /health            — readiness probe
    POST /compress          — compress one prompt
    GET  /info              — model + capability info

We use the small llmlingua-2 model by default; it ships under
microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank
(~440 MB) and runs on CPU at usable speed for the chat use case.
First invocation downloads it via HuggingFace; subsequent calls reuse
the cache.

Args:
    sys.argv[1] = port (int)
    sys.argv[2] = optional override model identifier
"""

from __future__ import annotations

import sys
import os
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn


DEFAULT_MODEL = "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"

log = logging.getLogger("blueprint.compress")
log.setLevel(logging.INFO)


app = FastAPI(title="Blueprint LLMLingua sidecar")

# Lazy globals — initialized on first compress call so /health responds
# before the model finishes loading.
_compressor: Optional[object] = None
_model_id: str = DEFAULT_MODEL


class CompressRequest(BaseModel):
    text: str
    target_ratio: float = 0.5  # 0.5 = keep ~half the tokens
    force_tokens: list[str] = []
    preserve_question: bool = True


class CompressResponse(BaseModel):
    compressed: str
    original_tokens: int
    compressed_tokens: int
    ratio: float
    model: str


def get_compressor():
    """Lazy-load the LLMLingua compressor."""
    global _compressor
    if _compressor is None:
        log.info("loading llmlingua compressor: %s", _model_id)
        # Local import keeps startup fast for /health probes.
        from llmlingua import PromptCompressor

        _compressor = PromptCompressor(
            model_name=_model_id,
            use_llmlingua2=True,
            device_map="cpu",
        )
        log.info("compressor ready")
    return _compressor


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _compressor is not None}


@app.get("/info")
def info():
    return {
        "name": "llmlingua-sidecar",
        "model": _model_id,
        "ready": _compressor is not None,
    }


@app.post("/compress", response_model=CompressResponse)
def compress(req: CompressRequest):
    if not req.text.strip():
        raise HTTPException(400, "text is empty")

    compressor = get_compressor()
    try:
        result = compressor.compress_prompt(
            req.text,
            rate=req.target_ratio,
            force_tokens=req.force_tokens or None,
            force_reserve_digit=True,
        )
    except Exception as exc:  # noqa: BLE001 — surface anything to the caller
        log.exception("compress failed")
        raise HTTPException(500, f"compress failed: {exc!r}")

    compressed = result.get("compressed_prompt", req.text)
    return CompressResponse(
        compressed=compressed,
        original_tokens=int(result.get("origin_tokens", 0)),
        compressed_tokens=int(result.get("compressed_tokens", 0)),
        ratio=float(result.get("ratio", 0.0).replace("x", ""))
            if isinstance(result.get("ratio"), str)
            else float(result.get("ratio", 0.0)),
        model=_model_id,
    )


def main():
    global _model_id
    if len(sys.argv) < 2:
        print("usage: compress.py PORT [MODEL_ID]", file=sys.stderr)
        sys.exit(2)
    port = int(sys.argv[1])
    if len(sys.argv) >= 3 and sys.argv[2]:
        _model_id = sys.argv[2]

    # Make HuggingFace hub cache deterministic + scoped to ~/.blueprint.
    home = os.environ.get("BLUEPRINT_HOME") or os.path.expanduser("~/.blueprint")
    os.environ.setdefault("HF_HOME", os.path.join(home, "hf-cache"))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    log.info("starting llmlingua sidecar on 127.0.0.1:%d", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
