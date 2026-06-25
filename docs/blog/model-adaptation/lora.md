---
title: "LoRA — when it makes sense and when it doesn't"
topic: model-adaptation
slug: lora
status: outline
estimatedReadMinutes: 12
summary: "Low-Rank Adaptation freezes the pretrained weights and trains a small pair of matrices that approximate the weight delta. Cheap to train, tiny to ship, fast to swap. Here's when to reach for it and when it's the wrong tool."
---

# LoRA — when it makes sense and when it doesn't

## TL;DR

- Freeze the pretrained weights. Add two trainable matrices `A (r × d)`
  and `B (d × r)` where `r` is the LoRA rank (typically 8–64). The
  effective weight update is `B @ A`, of rank `r`.
- ~99% fewer trainable parameters than full fine-tuning. Trains on one
  consumer GPU.
- Output is a ~10–100 MB adapter file. Multiple adapters can be loaded
  on top of the same base model.

## Outline

### Section 1 — Why low-rank?

- Empirical observation: the weight updates induced by fine-tuning tend
  to live in a low-rank subspace.
- The math: `W' = W + ΔW`. LoRA forces `ΔW = B @ A` where `A, B` are
  much smaller than `W`. Forward pass: `h = W x + B (A x)`.
- One equation. Two paragraphs of intuition. Stop there.

### Section 2 — When LoRA wins

- < 10K labeled examples.
- Need a tunable behavior change ("respond in the company's tone of
  voice", "always cite Pennsylvania case law", "always emit JSON").
- Shipping pressure: LoRA trains in hours on a single 24 GB GPU.
- Multi-tenant scenarios: 50 clients, 50 adapters, one base model in
  memory.

### Section 3 — When LoRA loses

- The base model genuinely doesn't know the domain at the embedding
  level. (Example: medical coding ontologies. The base never saw the
  vocabulary.) LoRA can't teach embeddings well — go to continued
  pre-training first, LoRA after.
- Output distribution shift is too large (e.g., teaching the model to
  emit a completely new structured format with no analogues in
  pretraining).
- Need calibration of probability distributions (e.g., confidence
  scores for downstream routing). LoRA's deltas tend to overcorrect.

### Section 4 — Hyperparameters that matter

- `r` (rank): 8 is fine for narrow tasks. 16–32 for broader behavior
  changes. > 64 rarely pays for itself.
- `lora_alpha`: the scaling factor. Common default: `2 * r`. The
  effective LR for the LoRA path is `alpha / r`.
- `target_modules`: which weight matrices get adapters. `q_proj`,
  `k_proj`, `v_proj`, `o_proj` for attention; sometimes `gate_proj`,
  `up_proj`, `down_proj` for the FFN. The default `attn` is the safe
  starting point.
- `lora_dropout`: 0.05–0.1 helps with small datasets.

### Section 5 — Client case study slot

> **Placeholder for a real engagement writeup.**
> Suggested template:
> Client: industry + scale.
> Data: number of examples, format, what made it interesting.
> Setup: base model, rank, target modules, batch size, LR, epochs.
> Result: quality lift on their eval set, adapter file size, inference
> overhead (basically nothing).
> The trade-off they hit: e.g., "had to use rank 32 instead of 8
> because dropping below missed long-tail terminology."

### Section 6 — Shipping LoRA in production

- llama.cpp supports `--lora-scaled <adapter> <scale>` natively. The
  scale parameter lets you blend (e.g., 0.5 for "halfway between base
  and adapter behavior").
- vLLM supports multi-LoRA serving with per-request adapter selection.
- HF transformers: `model.load_adapter(...)`.
- Storage: ~10–100 MB per adapter. A 50-client multi-tenant setup is
  ~5 GB of adapters on top of a single 14 GB base.

## Recommended pull-quote

> "LoRA is the right tool 80% of the time you're asked to 'fine-tune
> a model on our data.' The other 20% is when the base model never saw
> your vocabulary — and there, no adapter will save you. Pre-train
> first."
