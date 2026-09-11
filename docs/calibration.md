# AI PR Review calibration

`cli:calibration` gives a repository-level Stage-1 quality signal for the AI review output. It reads trusted terminal runs, canonical artifacts, maintainer reactions and CI evidence to produce a deterministic report.

Run:

```bash
npm run cli:calibration -- --repository <owner>/<repo>
```

Optional:

- `--json-out <path>` writes the JSON report payload to disk.
- `--known-security-boundary-violations N` overrides the numeric known security-boundary incident count (default `0`).

The JSON report includes this exact shape:

- `schema_version`
- `repository`
- `completed_live_reviews`
- `evaluated_blocking_cases`
- `completed_review_rate`
- `unable_rate`
- `false_block_rate`
- `blocking_finding_precision`
- `material_miss_rate`
- `p50_latency_ms`
- `p95_latency_ms`
- `median_cost_usd`
- `p95_cost_usd`
- `known_security_boundary_violations`
- `stage2_criteria_met`

## Calibration definitions

- `completed_live_reviews` counts terminal attempts that produced valid PASS/BLOCK state.
- `evaluated_blocking_cases` counts reviewed BLOCK outcomes with at least one unambiguous maintainer reaction.
- `false_block_rate` is `false / total` over labeled blocking findings reactions (`👍` vs `👎`).
- `blocking_finding_precision` is ratio of labeled valid blocking findings to total labeled blocking findings.
- `material_miss_rate` is labeled post-PASS material blocker reports divided by labeled PASS outcomes.
- `p50_latency_ms` and `p95_latency_ms` measure latency from primary CI completion to successful publisher completion for successful canonical attempts only.
- `median_cost_usd` / `p95_cost_usd` are from `estimated_cost_usd` telemetry; missing usage stays `null`.
- `unable_rate` counts conservative technical inability, including incomplete/rejected attempts and attempts with missing or failed review execution.

`STALE_SKIPPED` outcomes are excluded from reliability denominators. Deterministic stale/preskip cases are not treated as evidence gaps.

## Authorizing feedback and labels

Maintainer feedback only comes from users with `write`, `maintain` or `admin` repository permission.

Summary verdict reactions in the bot-authored summary comment (`PR-level`):

- `👍` = summary verdict is correct
- `👎` = summary verdict is incorrect

Inline high-confidence blocking finding reactions:

- `👍` = finding is valid
- `👎` = finding is a false positive

Only unambiguous reactions are counted. Silence is excluded.

For `PASS` followed by a later human-discovered blocker, only this exact marker counts:

```html
<!-- ai-pr-review-material-miss:v1:${headSha} -->
```

## Stage 2 criteria

`stage2_criteria_met` is advisory-only and true only when all conditions pass:

- `completed_live_reviews >= 25`
- `evaluated_blocking_cases >= 10`
- `false_block_rate <= 0.05`
- `blocking_finding_precision >= 0.90`
- `material_miss_rate <= 0.10`
- `completed_review_rate >= 0.95`
- `unable_rate <= 0.05`
- `p95_latency_ms <= 900000`
- `known_security_boundary_violations == 0`

`stage2_criteria_met` does not mutate rulesets. Stage 2 rollout is a separate human decision.

## Cost warnings

Cost alerts are advisory and do not fail calibration:

- warning when `median_cost_usd > 1`
- warning when `p95_cost_usd > 2`

`Known security boundary violations` are operator-supplied.

Default `0` means no incidents were supplied, not an independent audit of absence.

`Engineering-owner approval is still required before changing required checks.`
