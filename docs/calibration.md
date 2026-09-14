# AI PR Review calibration

`cli:calibration` gives a repository-level Stage-1 quality signal for the AI review output. It reads trusted terminal runs, canonical artifacts, maintainer reactions and CI evidence to produce a deterministic report.

Run:

```bash
npm run cli:calibration -- --repository gushinets/payments-portal
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
- `total_input_tokens`
- `total_output_tokens`
- `token_usage_samples`
- `provider_failures` with exactly `config_invalid`, `auth_failed`, `rate_limited`, `quota_exhausted`, `unavailable`
- `known_security_boundary_violations`
- `stage2_criteria_met`

## Stage 1 baseline

The Stage 1 baseline snapshot is recorded in `docs/stage1-acceptance.md`. Calibration is evaluated per repository; Platform and Payments do not share denominators or approval state.

Early Stage 1 sample sizes are expected to sit below Stage 2 thresholds. `stage2_criteria_met=false` is normal until enough retained canonical artifacts and authorized feedback exist.

Null quality or latency metrics mean insufficient labeled evidence, not zero defects and not zero latency. Token totals include only reported telemetry fields; zero totals with `token_usage_samples=0` mean usage was not reported in retained canonical state.

Provider failure categories remain diagnostic breakdowns of canonical `UNABLE_TO_REVIEW` outcomes. Token Plan Credits remain externally authoritative in Alibaba subscription usage or operator evidence; calibration must not infer Credits or spend.

No automatic ruleset mutation exists. Future Stage 2 requires the criteria below to pass for the repository and still needs explicit engineering-owner approval.

## Calibration definitions

- `completed_live_reviews` counts terminal attempts that produced valid PASS/BLOCK state.
- `evaluated_blocking_cases` counts reviewed BLOCK outcomes with at least one unambiguous maintainer reaction.
- `false_block_rate` is incorrect BLOCK summary verdicts divided by evaluated BLOCK summary verdicts. Inline reactions do not label the PR-level verdict.
- `blocking_finding_precision` is ratio of labeled valid blocking findings to total labeled blocking findings.
- `material_miss_rate` is PASS attempts with an authorized post-PASS exact material-miss marker divided by PASS attempts with either an unambiguous authorized verdict reaction or an authorized material-miss marker. A PASS dislike alone is not a material miss; silence is excluded.
- `p50_latency_ms` and `p95_latency_ms` measure latency from primary CI completion to successful publisher completion for successful canonical attempts only.
- Latency uses the latest matching primary-CI job completion at or before review start and the earliest successful publisher completion for the canonical attempt, including publisher recovery. p50 is the conventional median; p95 uses nearest rank. If any completed review lacks CI/publication timing, both latency percentiles remain `null`.
- Token totals sum each non-null canonical telemetry field independently, including usage from UNABLE outcomes. `token_usage_samples` counts distinct canonical attempts with at least one non-null input/output field; reported zero is an observation, while both fields null are not. Zero totals with no observations do not establish zero usage. Reused artifacts are counted once.
- `provider_failures` counts canonical UNABLE reasons `PROVIDER_CONFIG_INVALID`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_EXHAUSTED`, and `PROVIDER_UNAVAILABLE` in their corresponding fields. Other UNABLE reasons and missing attempts do not invent provider failures.
- `unable_rate` counts conservative technical inability, including incomplete/rejected attempts and attempts with missing or failed review execution.

`STALE_SKIPPED` outcomes are excluded from reliability denominators. Deterministic stale/preskip cases are not treated as evidence gaps.

The observation window is the configured artifact retention period (90 days), measured by attempt start. Trusted terminal workflow attempts with missing review evidence remain in the reliability denominator as technical inability. Pending runs are reported separately. Canonical artifacts are validated through the existing GitHub artifact store; incomplete pagination, corrupt retained state or detected evidence changes fail collection. No new persistence backend is used.

## Authorizing feedback and labels

Maintainer feedback only comes from human users whose repository permission at evaluation time is `write`, `maintain` or `admin`. Permissions are looked up during collection; `read`, `triage`, no access and bot accounts do not count.

Summary verdict reactions in the bot-authored summary comment (`PR-level`):

- `👍` = summary verdict is correct
- `👎` = summary verdict is incorrect

Inline high-confidence blocking finding reactions:

- `👍` = finding is valid
- `👎` = finding is a false positive

Only unambiguous reactions are counted; conflicting authorized thumbs-up/down are unlabeled. Silence is excluded. Summary feedback must target the bot-owned current-head summary and its exact canonical-attempt marker. Inline feedback must target a bot-owned, fingerprinted high-confidence blocking finding for the reviewed head. Reactions must postdate both review completion and the comment's latest update; remove and re-add reactions after summary updates.

For `PASS` followed by a later human-discovered blocker, only this exact marker counts:

```html
<!-- ai-pr-review-material-miss:v1:${headSha} -->
```

The authorized user's PR timeline comment must be created after the AI PASS completed and contain that exact literal marker for the reviewed head. Surrounding prose is allowed; prose without the marker, another head/version, altered marker syntax and HTML-escaped examples do not count.

## Stage 2 criteria

`stage2_criteria_met` is advisory-only and true only when all conditions pass:

- `completed_live_reviews >= 25`
- `evaluated_blocking_cases >= 10`
- `false_block_rate != null && false_block_rate <= 0.05`
- `blocking_finding_precision != null && blocking_finding_precision >= 0.90`
- `material_miss_rate != null && material_miss_rate <= 0.10`
- `completed_review_rate >= 0.95`
- `unable_rate <= 0.05`
- `p95_latency_ms != null && p95_latency_ms <= 900000` (15 minutes)
- `known_security_boundary_violations == 0`

`stage2_criteria_met` does not mutate rulesets. Stage 2 rollout is a separate human decision.

Provider failure counts are diagnostic breakdowns of UNABLE outcomes, not an additional Stage-2 gate. Repeated quota/concurrency failures remain visible for the engineering-owner decision and still contribute to the ordinary reliability rates.

## Token Plan usage

Token Plan Credits are authoritative in Alibaba subscription usage.
This report does not infer Credits or PAYG dollar spend from token counts.

Legacy canonical `estimated_cost_usd` telemetry remains compatible with stored history but is not used by calibration. The report has no dollar percentiles or dollar alerts. CLI Markdown shows all nine criteria, token totals, provider failures and evidence coverage; optional JSON contains only the report contract above.

`Known security boundary violations` are operator-supplied.

Default `0` means no incidents were supplied, not an independent audit of absence.

`Engineering-owner approval is still required before changing required checks.`
