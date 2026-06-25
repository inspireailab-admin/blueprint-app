# Blueprint blog — content scaffold

The blog lives here in repo until we wire it into the marketing site
(`inspireailab.com/blog` or `blueprint.inspireailab.com/blog`).
Articles are Markdown with front matter; each topic is its own
directory, each article its own file.

## Topics

- [`model-adaptation/`](./model-adaptation/) — LoRA, QLoRA, SFT, DPO,
  distillation, continued pre-training. This is where the consulting
  story for "we adapt models to your data" gets the technical depth
  that backs it up.

## Article front matter

Each article starts with:

```markdown
---
title: "How LoRA actually works"
topic: model-adaptation
slug: how-lora-actually-works
publishedAt: 2026-07-15
author: Inspire AI Lab
estimatedReadMinutes: 12
summary: "Single-paragraph hook used for the article card on the topic page."
---
```

## Authoring guidelines

1. **Anchor every article on a real client use case.** A theoretical
   description of QLoRA is useful; a walkthrough of "we LoRA-tuned
   Llama-3.1-8B on 18,000 of an insurance carrier's claim notes,
   produced a 47 MB adapter, and quality on their internal eval set
   went from 71% to 89%" is what wins engagements.
2. **Show the math when it sharpens the argument.** LoRA's low-rank
   factorization, DPO's preference loss, distillation's KL term — one
   equation each, with the reader gaining intuition from it. No
   pure-math sections that drop the non-ML reader.
3. **Show the code, in small bites.** A 6-line `peft.LoraConfig`
   snippet is more useful than a 200-line training script. Link the
   full script in a footnote.
4. **End with a one-line conclusion the client can quote back to
   their CTO.** "Use LoRA when you have under ~10K labeled examples
   and need to ship in days, not weeks" beats "in conclusion."
