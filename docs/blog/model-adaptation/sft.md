---
title: "SFT — supervised fine-tuning fundamentals"
topic: model-adaptation
slug: sft
status: outline
estimatedReadMinutes: 14
summary: "Supervised fine-tuning is the workhorse of LLM adaptation: pairs of (prompt, ideal response), cross-entropy loss, done. Most of the difficulty is in the data, not the training loop."
---

# SFT — supervised fine-tuning fundamentals

## TL;DR

- Format: `{instruction, input, response}` (Alpaca-style) or messages
  array (chat-style).
- Loss: standard next-token cross-entropy, masked so loss is computed
  ONLY on the response tokens, not the prompt.
- Output: full weight delta (if full fine-tuning) or LoRA adapters
  (if PEFT).
- Most of the engineering is data, not training.

## Outline

### Section 1 — The data shape that actually matters

- Chat template: every model has one. Mistral's `<s>[INST] ... [/INST]`
  is different from Llama's `<|start_header_id|>`. Get this wrong and
  the model never learns the conversation structure.
- Prompt loss masking: by default, transformers' Trainer computes loss
  on the whole sequence. For SFT you mask out the prompt so the model
  doesn't learn to regenerate the prompt.
- System prompt handling: include it in training data, or don't, but
  decide once. Inference and training must match.

### Section 2 — Quality of the dataset is everything

- 5K excellent examples > 100K mediocre ones. Empirically validated on
  Llama-2 + Alpaca lineage.
- Hand-curate or use rejection sampling: have a stronger model generate
  candidates, filter by quality, train on the survivors. (This is what
  Anthropic and OpenAI's RLHF pipelines do at scale.)
- Diversity matters: cover the long tail of the actual workload, not
  just the common cases.

### Section 3 — Hyperparameters

- LR: 2e-5 to 5e-5 for full fine-tuning; 1e-4 to 3e-4 for LoRA.
- Warmup: 3% of total steps.
- Cosine LR schedule.
- Epochs: 3 is the standard. More than that and you overfit the
  training distribution.
- Batch size: max what your GPU fits. Use gradient accumulation if
  you need bigger effective batch.

### Section 4 — The eval question that comes up every time

- "How do I know it's better?"
- Holdout split (10–20% of your data, no training contamination).
- Domain-specific eval set the client provides.
- Win-rate evaluation: have GPT-4 judge pairs of (baseline output,
  fine-tuned output) blind. Anchor to a metric the client cares about.
- WARNING: don't ship without measuring on the client's own eval set.
  Generic benchmarks lie.

### Section 5 — Client case study slot

> **Placeholder.**
> Suggested anecdote: "Client: regional bank. Workload: classify
> customer chat into 12 intent categories. Data: 8,400 examples,
> already labeled. Approach: SFT on Llama-3.1-8B, full fine-tuning
> (had a 4x A100 box). Result: F1 went from 0.74 (base + 3-shot
> prompt) to 0.92 (fine-tuned). Failure cases shrank to actually
> ambiguous edge cases."

### Section 6 — When NOT to SFT

- < 1K examples: prompt engineering + RAG will beat SFT and cost less.
- Domain knowledge that needs to be referenced at inference time, not
  memorized (e.g., constantly-updated product catalog): RAG.
- Tasks the base model already does well: SFT is overkill.

## Recommended pull-quote

> "SFT is mostly a data engineering project pretending to be a machine
> learning project. The training loop is 50 lines. The dataset
> preparation is a month."
