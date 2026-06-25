---
title: "DPO — preference alignment without RLHF's complexity"
topic: model-adaptation
slug: dpo
status: outline
estimatedReadMinutes: 12
summary: "Direct Preference Optimization aligns a model to preferences (A is better than B) without the reward-model + PPO machinery of RLHF. One loss function, no rollouts. Usually the right starting point after SFT."
---

# DPO — preference alignment without RLHF's complexity

## TL;DR

- Input: triplets `(prompt, chosen_response, rejected_response)`.
- Loss: a closed-form expression that pulls the policy toward `chosen`
  and away from `rejected`, regularized by KL divergence from a
  reference policy (usually the post-SFT model).
- No reward model. No PPO. Trains like SFT.

## Outline

### Section 1 — Why DPO instead of RLHF

- RLHF: train a reward model on preferences, then PPO-train the policy
  against that reward model with a KL penalty to a reference policy.
  Three moving pieces, training instabilities, careful tuning.
- DPO: skip the reward model entirely. The DPO loss is the PPO
  objective with the reward model substituted out analytically.
- Result: same training loop as SFT, much higher stability.

### Section 2 — The data shape

- `{prompt, chosen, rejected}`. That's it.
- Sources of preference data:
  - Human ratings: pay annotators to pick the better of two responses.
  - Heuristic: domain-specific rules (e.g., "the response that
    correctly cites the policy section number is `chosen`").
  - LLM-judged: use a stronger model to label which response is
    better. Cheap, scales, but inherits the judge's biases.

### Section 3 — Hyperparameters

- `beta`: the KL regularization strength. 0.1–0.3 is the working
  range. Lower = more aggressive preference learning, more risk of
  catastrophic forgetting. Higher = more conservative.
- LR: 1e-6 to 5e-6 for full fine-tuning; 5e-6 to 5e-5 with LoRA.
  Much lower than SFT — DPO is sensitive.
- Epochs: 1 is usually enough. 2 if data is small (< 5K pairs).

### Section 4 — The one failure mode you must watch for

- The model can learn to game DPO by reducing log-probability on
  both `chosen` and `rejected`, just maintaining their relative
  ranking. This makes the model degenerate over time even though the
  loss looks fine.
- Mitigations: weight the standard SFT loss into the objective (DPO+SFT
  hybrid), or use the IPO / KTO variants that handle this better.

### Section 5 — Client case study slot

> **Placeholder.**
> Suggested anecdote: "Client: SaaS company. Goal: make the support
> chatbot more empathetic without sacrificing accuracy. Data: 3,200
> response pairs labeled by their senior CX manager. Approach: SFT
> first (their existing playbook responses), then DPO on the empathy
> ratings. Result: Likert-rated empathy went 3.1 → 4.2 (on a 5-point
> scale), accuracy held within 1.5%."

### Section 6 — When DPO loses

- You don't have preference data. (Get some. It's worth more than a
  bigger model.)
- You actually want exploration in the response space (RLHF's PPO
  rollouts produce more diverse policies). DPO is monotonic.
- Distribution-level alignment (e.g., refuse-rate calibration). DPO
  shifts behavior; calibration usually needs different objectives.

## Recommended pull-quote

> "DPO is the unreasonable effectiveness of throwing the reward model
> in the bin. One loss, no rollouts, ships next week."
