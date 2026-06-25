---
title: "QLoRA — training on a quantized base when VRAM is tight"
topic: model-adaptation
slug: qlora
status: outline
estimatedReadMinutes: 10
summary: "Same idea as LoRA, but the frozen base is held in 4-bit precision so a single 24 GB GPU can train an adapter on a 70B model. Costs ~30% throughput vs LoRA, but unlocks hardware most clients actually own."
---

# QLoRA — training on a quantized base when VRAM is tight

## TL;DR

- Hold the frozen base weights in 4-bit (NF4 format).
- Train the LoRA adapters in BF16 on top.
- Result: 13B fits on 12 GB, 70B fits on 48 GB. 30% throughput hit vs
  full LoRA, but you trained at all.

## Outline

### Section 1 — The three knobs QLoRA introduces

- **NF4 (NormalFloat 4-bit)** for storage of the frozen weights. Distributed
  to match the empirical distribution of pretrained weights (~Gaussian).
- **Double quantization**: the quant constants themselves are quantized.
  Saves ~0.4 bpw — meaningful at scale.
- **Paged optimizers**: optimizer state (Adam β1/β2 moments) gets paged
  to CPU RAM via NVIDIA UVM when VRAM is tight. Doesn't slow training
  noticeably if you have CPU RAM to spare.

### Section 2 — When QLoRA wins over LoRA

- You're on a 24 GB consumer card and want to train on a 13B+ base.
- Your client gave you 8x A100 40GB nodes and the model is 70B+. QLoRA
  on 8x A100 fits comfortably; LoRA does not.
- Budget: cloud QLoRA on a 70B is ~$30–60 of GPU rental for an
  overnight run. LoRA on the same model would need 2–4× the hardware
  for the same throughput.

### Section 3 — When QLoRA loses

- You have enough VRAM for full LoRA. The 30% throughput hit is not
  worth it.
- Quality-sensitive workloads where the NF4 quantization noise of the
  frozen base limits how well the adapter can compensate. Rare in
  practice but worth measuring.

### Section 4 — Hyperparameters

- `bnb_4bit_compute_dtype`: BF16 is the standard. FP16 works but
  numerically dicier on long-context training.
- `bnb_4bit_quant_type`: "nf4". Stick with the default.
- `bnb_4bit_use_double_quant`: True. Free win.
- LoRA hyperparameters per the LoRA article — QLoRA doesn't change
  those.

### Section 5 — Client case study slot

> **Placeholder.**
> Suggested anecdote: "Client wanted Llama-3.1-70B fine-tuned on their
> 12K customer-support tickets. Their on-prem GPU was 2x RTX A6000 48GB.
> Full LoRA: doesn't fit. QLoRA: fits with 4 GB to spare. 9 hours of
> training. Adapter file: 89 MB. Quality on their internal CSAT-prediction
> eval went from 0.61 to 0.78."

### Section 6 — Shipping QLoRA-trained adapters

- The adapter is just LoRA — no QLoRA-specific format. It loads on top
  of either the full-precision base or a quantized base at inference
  time.
- Most production setups: train with QLoRA, serve the adapter on top
  of a llama.cpp Q4_K_M base. Inference is fast; the QLoRA was a
  training-time concession only.

## Recommended pull-quote

> "QLoRA is what happens when you ask: how much can we shrink the
> frozen part without hurting the trainable part? Turns out: a lot."
