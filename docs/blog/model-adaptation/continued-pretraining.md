---
title: "Continued pre-training — what changes when you go past SFT"
topic: model-adaptation
slug: continued-pretraining
status: outline
estimatedReadMinutes: 13
summary: "When the base model never saw your domain's vocabulary or syntax, no SFT or LoRA will save you. Continued pre-training on a domain corpus updates the model's actual knowledge. Heavier than SFT; the right tool for genuinely specialized domains."
---

# Continued pre-training — what changes when you go past SFT

## TL;DR

- Take a pretrained base model. Continue training it on a large
  unlabeled corpus of in-domain text using the same masked-language /
  next-token objective the base was trained on.
- Output: a new base model with the domain knowledge baked in.
- Usually followed by SFT on instruction-style data, then optionally
  DPO.

## Outline

### Section 1 — When SFT can't get you there

- The base model's tokenizer doesn't represent your domain efficiently
  (e.g., chemical SMILES strings, medical billing codes, your
  company's API endpoints with unique tokens).
- The base model's facts are wrong. (Example: any model older than your
  product launch doesn't know your product exists.)
- The base model's syntax expectations don't match the domain.
  (Example: SQL dialects, low-resource programming languages.)
- Symptom: SFT plateaus at mediocre quality no matter how much data
  you throw at it. The model is fighting prior knowledge.

### Section 2 — Data scale and quality

- 100M+ tokens minimum to move the needle.
- 1B+ tokens is the comfortable territory.
- 10B+ tokens starts pushing the dial on capability, not just
  knowledge.
- Quality matters: a high-quality 100M corpus often beats a noisy 1B
  corpus.
- De-duplication is critical. Near-duplicates inflate training data
  and degrade learning.

### Section 3 — Catastrophic forgetting

- The risk: continued pre-training on a narrow corpus erodes the
  general capabilities the base model had.
- Mitigations:
  - Mix in 5–15% general-domain pretraining data (e.g., a slice of
    SlimPajama or RedPajama-2) during continued pre-training.
  - Lower the learning rate vs the original pre-training (LR / 10).
  - Don't train too long. Monitor a general-capability eval (e.g.,
    MMLU) alongside your domain eval — stop when the general one
    starts dropping.

### Section 4 — Hyperparameters

- LR: 10–100× lower than the original pre-training LR.
  Llama-2 was pretrained at 3e-4; continued pre-training: 3e-6 to 3e-5.
- Sequence length: match what you'll serve, not the original 4K.
  Continued pre-training is a chance to extend context length too
  (e.g., with rope scaling).
- Batch size: max for the box. Gradient accumulation to reach an
  effective batch of 1M+ tokens.
- Total training tokens: 100M is the floor, 1B–10B is the working
  range.

### Section 5 — Client case study slot

> **Placeholder.**
> Suggested anecdote: "Client: pharmacovigilance. Their workload was
> identifying adverse drug reactions in unstructured clinician notes.
> The base Llama-3 model knew clinical terms but had never seen the
> specific dialect their notes used (heavy abbreviation, drug code
> shorthand). SFT alone got them to 71% F1. Continued pre-training on
> 1.2B tokens of their internal notes corpus (de-identified) +
> SFT got them to 89%. Continued pre-training was the unlock."

### Section 6 — The hardware reality

- A 7B continued pre-training run on 1B tokens needs ~8x A100 80GB
  nodes for ~5 days at a comfortable batch size.
- Cost: typically $5K–$20K of cloud GPU time, or 1–2 weeks on a
  decent on-prem cluster.
- This is a real investment. Worth it only when SFT/LoRA aren't
  enough.

## Recommended pull-quote

> "Continued pre-training is what you do when no amount of clever
> prompting or fine-tuning can fix the fact that the model doesn't
> know your world. It's expensive. When the alternative is shipping
> the wrong answer, it's also unavoidable."
