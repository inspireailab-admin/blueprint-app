---
id: sql-apex
domain: nl-to-sql
scoring: rouge-l
base_model: llama-3.2-3b-instruct
calibration_size: 30
eval_size: 20
schema: apex_manufacturing
expected_delta_pct: 8
---

# SQL generation — Apex Manufacturing

A fictional manufacturing company called **Apex** with the following
schema:

```sql
workers          (id, name, plant_code, role, hire_date, hourly_rate)
shifts           (id, worker_id, shift_date, start_time, end_time, plant_code)
products         (sku, name, category, unit_cost)
production_runs  (id, sku, plant_code, run_date, units_produced, defect_count)
```

The base model has never seen this schema. Stock Llama 3.2 3B will
guess column names that look plausible ("employee_id", "production_date")
but don't match. The custom-calibrated quant, trained on prompts that
consistently use Apex's table/column names, learns the mapping and
generates queries that compile against the actual schema.

ROUGE-L scoring captures the token-overlap win without penalizing
syntactic variations (different aliases, whitespace).

**Expected delta**: +5% to +10% mean ROUGE-L on the eval set after
custom calibration vs the stock pre-quant.

This is a smaller starter dataset (30 calibration / 20 eval) — author
more entries if a longer run is desired.
