---
topic: model-adaptation
title: "Model adaptation"
summary: "How to make a pretrained LLM yours: LoRA, QLoRA, SFT, DPO, distillation, and continued pre-training. Pick the one that matches your data, your hardware, and your timeline."
---

# Model adaptation

A pretrained model knows the internet. Your client has knowledge the
internet doesn't — case law for one jurisdiction, internal API docs,
ten years of customer support transcripts, the specific shape of the
schema their data warehouse uses. Adaptation is how you teach a model
that.

## Articles

1. [LoRA — when it makes sense and when it doesn't](./lora.md)
2. [QLoRA — training on a quantized base when VRAM is tight](./qlora.md)
3. [SFT — supervised fine-tuning fundamentals](./sft.md)
4. [DPO — preference alignment without RLHF's complexity](./dpo.md)
5. [Knowledge distillation — when to train a smaller student](./distillation.md)
6. [Continued pre-training — what changes when you go past SFT](./continued-pretraining.md)

## How to pick

| Situation | What to use |
|---|---|
| < 1K labeled examples, need to ship this week | LoRA |
| Under-spec'd GPU (24 GB or less) for a 13B+ model | QLoRA |
| 5K–500K instruction/response pairs, want quality lift | SFT |
| Have preference data (A > B) or human ratings | DPO after SFT |
| Want a 10× smaller model that mimics a flagship | Distillation |
| 10M+ tokens of in-domain text, base model is the wrong specialist | Continued pre-training |
