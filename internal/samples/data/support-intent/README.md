---
id: support-intent
domain: customer-support-classification
scoring: exact
base_model: llama-3.2-3b-instruct
calibration_size: 100
eval_size: 60
intents: 10
expected_delta_pct: 12
---

# Customer-support intent — Stellaron Cloud

A fictional SaaS company called **Stellaron Cloud** sells a workflow
automation platform with three tiers: **Quasar Basic**, **Nebula Pro**,
**Galaxia Enterprise**. Users contact support with one of ten intents.

Your job as the consulting team: produce a custom-calibrated quant
that beats the bartowski stock pre-quant on Stellaron's tickets.

## The ten intents

| Label | Means |
|---|---|
| `cancel_subscription` | User wants to end their paid subscription |
| `refund_request` | User wants money back for an existing charge |
| `technical_issue` | Something is broken or misbehaving |
| `billing_question` | Question about a charge, invoice, or payment method |
| `password_reset` | Lost access, can't log in due to credentials |
| `account_locked` | Account locked by anti-fraud or security flag |
| `upgrade_request` | Wants to move to a higher tier |
| `downgrade_request` | Wants to move to a lower tier |
| `feature_request` | Suggests new functionality |
| `general_inquiry` | Anything else |

## Why custom calibration wins here

The stock Llama 3.2 3B at IQ4_XS / Q4_K_M has perfect English coverage
but no knowledge of "Quasar", "Nebula", "Galaxia" as Stellaron product
tier names. When a message says "I want to move from Quasar to Nebula
without losing my projects" the stock quant misclassifies — most often
as `feature_request` or `general_inquiry`. The custom-calibrated quant,
trained on prompts that consistently use these terms with the right
intent, learns the mapping.

Expected delta: **+10% to +15%** mean exact-match accuracy on the eval
set after custom calibration vs the stock pre-quant. The headline
"custom Q4_K_M beats stock by ~12%" is what you'll show the demo
audience.

## How to use it

1. Pull `llama-3.2-3b-instruct` Q8 via Plan → Deploy (Q8 is the
   recommended calibration base — highest fidelity available before
   FP16).
2. In Calibrate, click "Load sample" → pick this dataset. The Run
   pre-populates with this corpus + eval set.
3. Walk steps 1–4 (prompts auto-saved → calibrate → quantize at
   IQ4_XS and Q4_K_M → evaluate against both custom + stock).
4. Open report.md to see the headline finding.
