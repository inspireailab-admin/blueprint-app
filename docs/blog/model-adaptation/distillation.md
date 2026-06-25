---
title: "Knowledge distillation — when to train a smaller student"
topic: model-adaptation
slug: distillation
status: outline
estimatedReadMinutes: 11
summary: "Distillation trains a small student model to mimic the output distribution of a larger teacher. The student is fast and cheap to serve; the cost is one-time training. Worth it when inference volume justifies the offline investment."
---

# Knowledge distillation — when to train a smaller student

## TL;DR

- Teacher: a large, expensive model that already does the task well.
- Student: a smaller model you'd rather serve.
- Loss: KL divergence between the student's output distribution and
  the teacher's, on the same inputs.
- The student inherits the teacher's specific behavior, not just its
  benchmark scores.

## Outline

### Section 1 — Three flavors

- **Response distillation**: the student trains on teacher-generated
  responses as if they were ground truth. Simplest. Used by the
  Alpaca / Vicuna lineage.
- **Logit distillation**: the student matches the teacher's full
  probability distribution at each token. Requires teacher logits at
  training time — expensive but signal-rich.
- **Hidden-state distillation**: align intermediate layer activations.
  Used in compression work (DistilBERT, DistilGPT2). Most complex,
  highest reward.

### Section 2 — When distillation wins

- Inference cost dominates training cost. (Production volume: millions
  of requests/month.) The one-time distillation amortizes fast.
- You need to deploy on a device class that won't fit the teacher
  (edge, mobile, laptop CPU).
- The teacher is an expensive API model and you want to repatriate
  the workload on-prem.

### Section 3 — When distillation loses

- Your inference volume is < 10K/day. Just keep using the teacher.
- The teacher's behavior is brittle and the student amplifies its
  quirks.
- The student's architecture is too small to represent the teacher's
  knowledge no matter how much data you throw at it.

### Section 4 — Hyperparameters

- `temperature` (T): how soft the teacher distribution is. T=2 to T=4
  is standard. T=1 is just response distillation.
- Loss weight `alpha`: balance between distillation loss and the
  standard cross-entropy on ground-truth labels. 0.5 is a sensible
  starting point.
- Student LR: same as SFT for the same student size.

### Section 5 — Client case study slot

> **Placeholder.**
> Suggested anecdote: "Client: e-commerce. Workload: product-question
> answering across a 200K-SKU catalog. Teacher: Claude Sonnet. Student:
> Llama-3.2-3B fine-tuned via response distillation on 75K
> teacher-generated answers. Result: student matches teacher on 91% of
> eval questions, costs 80× less to serve. Break-even on the
> distillation investment: 6 weeks of production traffic."

### Section 6 — The legal question

- API model providers' terms typically prohibit using their outputs to
  train competing models. Read the ToS carefully.
- Open-weight teachers (Llama, Qwen, DeepSeek) generally permit
  distillation under their licenses. Verify per license.

## Recommended pull-quote

> "Distillation is the bet that one expensive training run pays for
> itself a million times over in cheaper inference. When the volume's
> there, it always does."
