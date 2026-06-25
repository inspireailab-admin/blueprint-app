---
id: contract-qa
domain: short-form-qa
scoring: rouge-l
base_model: llama-3.2-3b-instruct
calibration_size: 30
eval_size: 20
document: vesper-indemnity-p2030
expected_delta_pct: 8
---

# Contract Q&A — Vesper Indemnity Bond P-2030

A fictional insurance product called the **Vesper Indemnity Bond P-2030**
with specific clause numbers, dollar caps, and exclusion language.
Each calibration prompt is a short Q with the expected short factual A.

The stock pre-quant knows English contracts in general but has never
seen P-2030's specific clause numbering or its named subsections
("Schedule B exclusions", "Clause 7.3 carve-out"). Custom calibration
teaches the model to retrieve and emit those exact references.

**Expected delta**: +5% to +10% mean ROUGE-L on the eval set after
custom calibration vs the stock pre-quant. The win shows up most
clearly on questions about specific clause numbers and dollar
amounts.

This is a smaller starter dataset (30 calibration / 20 eval) — author
more entries if a longer run is desired.
