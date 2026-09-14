# AI PR Review Stage 1 Acceptance

## Decision

Stage 1 ACCEPTED.

GitHub-side acceptance evidence for the frozen engine is verified, and the required external Alibaba Token Plan subscription usage/Credits check is complete.

Token Plan subscription usage was checked externally in Alibaba Model Studio Token Plan -> My Subscriptions on 2026-09-14. The active subscription and Credits consumption were visible. No Credits or monetary spend were inferred from local token telemetry.

Stage 2 is NOT enabled by this acceptance record. AI PR Review remains informational. No repository ruleset was changed.

## Accepted identities

- Central acceptance source SHA: `67096624a0513d7316e9babf41529c8ab94565f8`.
- Frozen promoted engine SHA: `660525298b8785158fc8339add65f0e5cd87e749`.
- Consumers: `gushinets/anytoolai-platform`, `gushinets/payments-portal`.
- Rejudge: `0.4.1`.
- Pi packages: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at `0.85.1`.
- Token Plan provider: `qwen-token-plan`.
- Token Plan endpoint: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
- Token Plan credential name: `QWEN_TOKEN_PLAN_API_KEY`.

The Task22 documentation commit SHA is intentionally not embedded here; it is PR metadata, not a production engine identity.

## Deterministic central verification

Central source `67096624a0513d7316e9babf41529c8ab94565f8` was verified before documentation edits.

- GitHub Actions CI run `34764196341`: Ubuntu 24.04, success, `npm ci`, `npm run check`, and `npm run build` passed; `44` test files and `925` tests passed, including `test/security/pi-confinement.test.ts` with `37` tests.
- Fresh Linux Docker verification on a Linux-owned filesystem: `npm ci` PASS, `npm run check` PASS, `npm run test:security` PASS, `npm run build` PASS.
- Difference from frozen engine `660525298b8785158fc8339add65f0e5cd87e749` to source `67096624a0513d7316e9babf41529c8ab94565f8`: Task19 GitHub E2E fixture/test additions only.

### Host-specific verification note

A Windows development host could not execute symlink-dependent confinement fixtures because the host itself rejected symlink creation with EPERM.

This was classified as an environment limitation, not a test failure of the confinement contract.

The exact acceptance source was verified in Linux, where the complete confinement suite passed.

## Runtime versions

- `rejudge`: `0.4.1` in `package.json` and `package-lock.json`.
- `@earendil-works/pi-ai`: `0.85.1` in `package.json` and `package-lock.json`.
- `@earendil-works/pi-coding-agent`: `0.85.1` in `package.json` and `package-lock.json`.
- `@earendil-works/pi-tui`: `0.85.1` in `package.json` and `package-lock.json`.
- Fixed model panel: `qwen-token-plan/qwen3.8-flash@medium`, `qwen-token-plan/deepseek-v4-pro-0813@high`, `qwen-token-plan/glm-5.2@high`, `qwen-token-plan/qwen3.8-max@xhigh`.

## Task 18 promotion evidence

- Repository: `gushinets/ai-pr-review`.
- Run: `34761353229`.
- Workflow: `Token Plan promotion smoke`.
- Head: `660525298b8785158fc8339add65f0e5cd87e749`.
- Attempt: `1`.
- Conclusion: `success`.
- Job: `promotion` (`103734642470`), success.
- Step evidence: `npm ci`, `npm run build`, `npm run test:security`, and `npm run cli:promotion-smoke` all succeeded.
- Artifacts: none expected for this workflow.

Authenticated promotion logs emitted sanitized scenario evidence only:

| Scenario | Outcome | Duration ms | Token telemetry |
| -------- | ------- | ----------: | --------------- |
| good     | PASS    |       97469 | unknown         |
| bad      | BLOCK   |      132005 | unknown         |
| repair   | PASS    |       35950 | unknown         |
| closure  | PASS    |      177683 | unknown         |

The promotion run proves the good fixture passes, the bad fixture blocks, same-run judge repair works, historical closure works, the Token Plan runtime/provider assertions hold, the security suite passes, and the fixed model panel is used. No fallback provider/model marker was found in the authenticated log scan.

## Task 19 GitHub E2E evidence

### Bad

- Repository: `gushinets/ai-pr-review-fixture`.
- PR/head: `#2` at `5054b1d1d04daad282f96c5f946ba8d452519882`.
- Primary CI: `Fixture CI` run `34762286440`, success.
- AI run: `34762297137`, success, reusable workflow SHA `660525298b8785158fc8339add65f0e5cd87e749`.
- Artifact: `10319387329`, `ai-review-state-v1-pr-2`, retained and not expired.
- Check: `103737887994`, `AI PR Review`, conclusion `failure`, exact head `5054b1d1d04daad282f96c5f946ba8d452519882`.
- Canonical outcome: `BLOCK`.
- Findings: `1` blocking and `1` non-blocking finding.
- Publication: stable summary by `github-actions[bot]` and two inline PR review comments on the bad head.

### Good

- Repository: `gushinets/ai-pr-review-fixture`.
- PR/head: `#2` at `959a8b7e661603b6d9e9b475e670f7e126af33a5`.
- Primary CI: `Fixture CI` run `34762932120`, success.
- AI run: `34762943251`, success, reusable workflow SHA `660525298b8785158fc8339add65f0e5cd87e749`.
- Artifact: `10319627716`, `ai-review-state-v1-pr-2`, retained and not expired.
- Check: `103739948891`, `AI PR Review`, conclusion `success`, exact head `959a8b7e661603b6d9e9b475e670f7e126af33a5`.
- Canonical outcome: `PASS`.
- Fresh findings: `0`.
- Historical closure: used, previous reviewed head `5054b1d1d04daad282f96c5f946ba8d452519882`, one terminal closure status `invalidated`.
- Publication: the existing stable summary comment was updated rather than duplicated.

### Linear unavailable

- Repository: `gushinets/ai-pr-review-fixture`.
- PR/head: `#3` at `67ddfedcde43609b1ef6667c9b5b1dc7ffd81eee`.
- Primary CI: `Fixture CI` run `34763611959`, success.
- AI run: `34763623489`, success, reusable workflow SHA `660525298b8785158fc8339add65f0e5cd87e749`.
- Artifact: `10319298127`, `ai-review-state-v1-pr-3`, retained and not expired.
- Check: `103741007423`, `AI PR Review`, conclusion `failure`, exact head `67ddfedcde43609b1ef6667c9b5b1dc7ffd81eee`.
- Canonical outcome: `UNABLE_TO_REVIEW`.
- Unable reason: `LINEAR_UNAVAILABLE`.
- `judge_result`: `null`.
- Models: none.
- Model call occurred: no; the review job emitted preflight-unable state and skipped the execute/model step.

## Platform rollout evidence

- Repository: `gushinets/anytoolai-platform`.
- Integration PR: `#116`, merged.
- Integration head: `5617652b32d7c1ae0c95457d6800ec98dec7abfa`.
- Integration merge commit: `2faf460e89a771e061fb808f6a8876acb6dc5ac9`.
- Current caller pin on `main`: `660525298b8785158fc8339add65f0e5cd87e749`.
- Current primary CI: `baseline-backend`.
- Current policy files: `AGENTS.md`, `docs/agent/coding-conventions.md`, `docs/agent/review-checklist.md`; no scoped policy.
- Smoke PR: `#117`, closed and unmerged.
- Smoke changed file: `docs/ai-pr-review-stage1-smoke.md`.
- Smoke head: `297161b9192177bc0f1b06ee4eaee9e4a0a2f118`.
- Primary run: `34771421596`, `baseline-backend`, success.
- AI run: `34771807910`, `workflow_run`, success, reusable workflow SHA `660525298b8785158fc8339add65f0e5cd87e749`.
- Artifact: `10322471550`, `ai-review-state-v1-pr-117`, retained and not expired.
- Check: `103763543156`, `AI PR Review`, conclusion `success`, exact head `297161b9192177bc0f1b06ee4eaee9e4a0a2f118`.
- Canonical outcome: `PASS`, `0` findings.
- Ruleset `protect main` (`17728731`) requires existing primary checks only; `AI PR Review` is not required.

## Payments rollout evidence

- Repository: `gushinets/payments-portal`.
- Integration PR: `#95`, merged.
- Integration head: `ab9ba776e46092a4b47b41d8116eb971b39d2aaa`.
- Integration merge commit: `be6351b2c8c71f210a7e4c1a8e4eeaa2060e1838`.
- Current caller pin on `main`: `660525298b8785158fc8339add65f0e5cd87e749`.
- Current primary CI: `CI`.
- Current always policy files: `AGENTS.md`, `docs/engineering/CODING_CONVENTIONS.md`.
- Current scoped policy: `apps/api/**` includes `apps/api/AGENTS.md`; `apps/web/**` includes `apps/web/AGENTS.md`.
- Smoke PR: `#96`, closed and unmerged.
- Smoke changed file: `apps/api/ai-pr-review-stage1-smoke.md`.
- Smoke head: `b2ecb2fa45e9e374910a31af3d6a314259467e97`.
- Primary run: `34771521399`, `CI`, success.
- AI run: `34771727206`, `workflow_run`, success, reusable workflow SHA `660525298b8785158fc8339add65f0e5cd87e749`.
- Artifact: `10322233556`, `ai-review-state-v1-pr-96`, retained and not expired.
- Check: `103763244709`, `AI PR Review`, conclusion `success`, exact head `b2ecb2fa45e9e374910a31af3d6a314259467e97`.
- Canonical outcome: `PASS`, `0` findings.
- API scoped policy selection for the real smoke path selects `AGENTS.md`, `docs/engineering/CODING_CONVENTIONS.md`, and `apps/api/AGENTS.md`; it excludes `apps/web/AGENTS.md`.
- Deterministic web scoped policy selection for `apps/web/example.ts` selects `AGENTS.md`, `docs/engineering/CODING_CONVENTIONS.md`, and `apps/web/AGENTS.md`; it excludes `apps/api/AGENTS.md`.
- Ruleset `protect main` (`18807104`) requires existing primary checks only; `AI PR Review` is not required.

## Security invariant matrix

| Invariant                                              | Evidence                                                                                                                                                                   | Result |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Unauthorized Token Plan invocation                     | Fixture Linear-unavailable run `34763623489` skipped execute/model and recorded no models.                                                                                 | PASS   |
| Reviewer filesystem escape                             | Fresh Linux `npm run test:security` passed, including `test/security/pi-confinement.test.ts`; promotion run `34761353229` also passed `npm run test:security`.             | PASS   |
| Secret leak                                            | Authenticated log scans for promotion, fixture, Platform, and Payments runs found no secret value or alternate credential markers; checkout headers were masked by GitHub. | PASS   |
| Raw private Linear publication by AI PR Review         | Canonical state and public comments expose verdict/summary surfaces only; consumer Linear linkbacks were from `linear-code[bot]`, not AI PR Review.                        | PASS   |
| Raw failed CI log publication                          | Canonical artifacts retain CI status summaries, not log bodies; no failed-log body marker was found in run scans.                                                          | PASS   |
| Raw model transcript publication                       | Authenticated run scans found no transcript marker; canonical artifacts contain sanitized state only.                                                                      | PASS   |
| Raw prompt publication                                 | Authenticated run scans found no prompt/transcript publication marker; canonical artifacts contain no prompt field.                                                        | PASS   |
| Wrong-head machine verdict                             | Every artifact `head_sha` matches its PR head, and every `AI PR Review` check is attached to that exact head.                                                              | PASS   |
| Stale-head machine verdict                             | Workflow exact-head checks and the E2E good/bad force-push sequence produced separate current-head checks.                                                                 | PASS   |
| PR-controlled code execution in privileged review path | Reusable workflow checks out central code at `job.workflow_sha`; PR code is materialized as inert evidence and tests cover this boundary.                                  | PASS   |
| Publisher access to Token Plan credentials             | Publisher job environment contains only GitHub credentials and downloads canonical state; Token Plan secret is only forwarded to the review execute step.                  | PASS   |
| Publisher access to Linear credentials                 | Publisher job environment contains only GitHub credentials; Linear credentials are only forwarded to prepare.                                                              | PASS   |
| Review/model phase access to GitHub write credentials  | Review job permissions are read-only; Rejudge children receive the Token Plan key allowlist only, no GitHub or Linear credentials.                                         | PASS   |
| PAYG fallback                                          | Runtime config, promotion evidence, and run scans show only `qwen-token-plan`; no PAYG marker found.                                                                       | PASS   |
| Coding Plan fallback                                   | Runtime config, promotion evidence, and run scans show only `qwen-token-plan`; no Coding Plan marker found.                                                                | PASS   |
| Alternate model/provider fallback                      | Fixed model panel is present in promotion and canonical telemetry; no alternate provider/model marker found.                                                               | PASS   |

Known unresolved security-boundary violations: `0`.

## Operational baseline

- Review latency samples from canonical artifacts: fixture BAD `172481` ms, fixture GOOD `372605` ms, fixture Linear-unavailable `758` ms, Platform smoke `247281` ms, Payments smoke `209614` ms.
- Promotion scenario durations: good `97469` ms, bad `132005` ms, repair `35950` ms, closure `177683` ms.
- Token telemetry: retained canonical artifacts report no input/output token samples; calibration token totals are `0` with `token_usage_samples=0`, which means usage telemetry is unknown, not zero external usage.
- Provider failures: Platform and Payments calibration report `0` for `config_invalid`, `auth_failed`, `rate_limited`, `quota_exhausted`, and `unavailable`.
- Parallel three-reviewer viability: promotion and live E2E/consumer runs completed with all three reviewers plus the judge using the fixed panel.
- Alibaba Credits external check: Token Plan subscription usage was checked externally in Alibaba Model Studio Token Plan -> My Subscriptions on 2026-09-14. The active subscription and Credits consumption were visible. No Credits or monetary spend were inferred from local token telemetry.

## Calibration baseline - Platform

- `repository`: `gushinets/anytoolai-platform`.
- `completed_live_reviews`: `1`.
- `evaluated_blocking_cases`: `0`.
- `completed_review_rate`: `0.3333333333333333`.
- `unable_rate`: `0.6666666666666666`.
- `false_block_rate`: `null`.
- `blocking_finding_precision`: `null`.
- `material_miss_rate`: `null`.
- `p50_latency_ms`: `null`.
- `p95_latency_ms`: `null`.
- `total_input_tokens`: `0`.
- `total_output_tokens`: `0`.
- `token_usage_samples`: `0`.
- `provider_failures.config_invalid`: `0`.
- `provider_failures.auth_failed`: `0`.
- `provider_failures.rate_limited`: `0`.
- `provider_failures.quota_exhausted`: `0`.
- `provider_failures.unavailable`: `0`.
- `known_security_boundary_violations`: `0`.
- `stage2_criteria_met`: `false`.

## Calibration baseline - Payments

- `repository`: `gushinets/payments-portal`.
- `completed_live_reviews`: `2`.
- `evaluated_blocking_cases`: `0`.
- `completed_review_rate`: `0.3333333333333333`.
- `unable_rate`: `0.6666666666666666`.
- `false_block_rate`: `null`.
- `blocking_finding_precision`: `null`.
- `material_miss_rate`: `null`.
- `p50_latency_ms`: `null`.
- `p95_latency_ms`: `null`.
- `total_input_tokens`: `0`.
- `total_output_tokens`: `0`.
- `token_usage_samples`: `0`.
- `provider_failures.config_invalid`: `0`.
- `provider_failures.auth_failed`: `0`.
- `provider_failures.rate_limited`: `0`.
- `provider_failures.quota_exhausted`: `0`.
- `provider_failures.unavailable`: `0`.
- `known_security_boundary_violations`: `0`.
- `stage2_criteria_met`: `false`.

## Stage 2 readiness

Platform:

| Criterion                                                                  | Result                |
| -------------------------------------------------------------------------- | --------------------- |
| `completed_live_reviews >= 25`                                             | NOT MET               |
| `evaluated_blocking_cases >= 10`                                           | NOT MET               |
| `false_block_rate != null && false_block_rate <= 0.05`                     | INSUFFICIENT EVIDENCE |
| `blocking_finding_precision != null && blocking_finding_precision >= 0.90` | INSUFFICIENT EVIDENCE |
| `material_miss_rate != null && material_miss_rate <= 0.10`                 | INSUFFICIENT EVIDENCE |
| `completed_review_rate >= 0.95`                                            | NOT MET               |
| `unable_rate <= 0.05`                                                      | NOT MET               |
| `p95_latency_ms != null && p95_latency_ms <= 900000`                       | INSUFFICIENT EVIDENCE |
| `known_security_boundary_violations == 0`                                  | MET                   |

Payments:

| Criterion                                                                  | Result                |
| -------------------------------------------------------------------------- | --------------------- |
| `completed_live_reviews >= 25`                                             | NOT MET               |
| `evaluated_blocking_cases >= 10`                                           | NOT MET               |
| `false_block_rate != null && false_block_rate <= 0.05`                     | INSUFFICIENT EVIDENCE |
| `blocking_finding_precision != null && blocking_finding_precision >= 0.90` | INSUFFICIENT EVIDENCE |
| `material_miss_rate != null && material_miss_rate <= 0.10`                 | INSUFFICIENT EVIDENCE |
| `completed_review_rate >= 0.95`                                            | NOT MET               |
| `unable_rate <= 0.05`                                                      | NOT MET               |
| `p95_latency_ms != null && p95_latency_ms <= 900000`                       | INSUFFICIENT EVIDENCE |
| `known_security_boundary_violations == 0`                                  | MET                   |

Stage 2 is NOT enabled by this acceptance record. AI PR Review remains informational. No repository ruleset was changed. A future Stage 2 rollout requires separate per-repository calibration and explicit engineering-owner approval.

## Known non-blocking observations

- The Task19 GOOD historical closure selected `invalidated`. The Task19 contract allowed `resolved` or `invalidated`, but the explanatory reasoning was weaker than ideal; this remains a calibration/model-quality observation.
- Third-party `linear-code[bot]` behavior is distinct from AI PR Review. Public consumer smoke PRs exposed only Linear issue link/key linkbacks from that bot.
- Windows symlink EPERM is a local host capability limitation, not evidence of a confinement failure. Linux verification is authoritative for symlink-dependent confinement tests.
- Token usage telemetry is absent from retained canonical state. This does not establish zero Token Plan usage.

## Final Stage 1 state

Stage 1 is accepted and remains informational.

- Stage 2 enabled: NO.
- Rulesets changed: NO.
- Runtime code changed: NO.
- Workflows changed: NO.
- Consumer pins changed: NO.
