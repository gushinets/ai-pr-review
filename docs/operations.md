# AI PR Review operations

The reusable workflow runs trusted central code on Ubuntu 24.04 with Node 22.19.0. Every job checks out the called workflow repository at `job.workflow_sha` and verifies that exact engine identity. Consumer PR code is inert review evidence; its scripts, dependencies and local actions are never executed.

## Stage 1 production acceptance record

The current Stage 1 evidence record is `docs/stage1-acceptance.md`.

- Central acceptance source SHA: `67096624a0513d7316e9babf41529c8ab94565f8`.
- Frozen promoted engine SHA: `660525298b8785158fc8339add65f0e5cd87e749`.
- Accepted Stage 1 consumers: `gushinets/anytoolai-platform` and `gushinets/payments-portal`.
- Primary CI names: `baseline-backend` for Platform and `CI` for Payments.
- Consumer callers remain pinned to the frozen engine by full SHA. A Task22 documentation commit is not a new engine SHA.
- Stage 1 is informational: keep `AI PR Review` out of required merge checks.
- `UNABLE_TO_REVIEW` is a fail-closed technical result. Fix the unavailable dependency, rerun the same review identity, and do not treat it as a code-only approval.
- Calibration reports are repository-level Stage 1 signals. They do not mutate rulesets and they do not authorize Stage 2 on their own.
- Token Plan Credits are authoritative only from Alibaba subscription usage or operator evidence. Do not infer Credits, PAYG dollars, or per-review spend from token counts.
- Before any consumer adopts a different engine SHA, repeat the real promotion and GitHub E2E gates for that exact engine.

For the Task22 record, Token Plan subscription usage was checked externally in Alibaba Model Studio Token Plan -> My Subscriptions on 2026-09-14. The active subscription and Credits consumption were visible. No Credits or monetary spend were inferred from local token telemetry.

## Consumer setup

- Pin `gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml` to a full commit SHA. Updating that pin is an explicit reviewed change.
- Set repository secrets `QWEN_TOKEN_PLAN_API_KEY`, `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, and forward each by name. Do not use `secrets: inherit`. The native ephemeral `GITHUB_TOKEN` is sufficient; no PAT is needed.
- No `ALIBABA_WORKSPACE_ID` variable or workspace input is used. The Token Plan key must be `sk-sp-...`, matching `^sk-sp-[A-Za-z0-9._-]+$`. The native Pi provider `qwen-token-plan` and endpoint `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` are central constants. Singapore is the accepted inference region for model-visible review context.
- Add the strict `.github/ai-review.yml` and policy files consumed from the PR base SHA. Missing or invalid configuration produces `UNABLE_TO_REVIEW`.
- The caller must allow `actions: read`, `contents: read`, `statuses: read`, `pull-requests: write` and `checks: write`. Central preflight and review jobs reduce those permissions to read-only; only publisher gets write access. No `issues: write` permission is requested.
- Automatic callers use `mode: automatic` with the completed primary CI `triggering_run_id`; omit `pr_number`. Primary CI names are `baseline-backend` for Platform and `CI` for Payments, regardless of CI conclusion. Manual maintainer dispatch uses `mode: manual` with a positive `pr_number`; omit `triggering_run_id`. The CLI validates numeric IDs and authorization before any Linear or model credential is used.
- Configure caller concurrency for each repository/PR with `cancel-in-progress: true`. This belongs to the consumer workflows; do not reuse the same cancel group in a nested workflow. Exact-head barriers remain active before persistence and publication.

Preflight has no Linear or model credentials. Prepare receives only read-only GitHub and Linear credentials; execute receives only read-only GitHub and the Token Plan key. Legacy `QWEN_API_KEY`, `BAILIAN_TOKEN_PLAN_API_KEY` and workspace routing are rejected by every review CLI phase. Rejudge children receive the Token Plan key through the explicit environment allowlist, no GitHub or Linear credentials, and `PI_OFFLINE=1`. Publisher receives only GitHub credentials and the current run's canonical state.

Provider configuration, authentication, rate-limit, quota and availability failures produce `UNABLE_TO_REVIEW`; there is no PAYG or Coding Plan fallback. Check Credits in Alibaba subscription usage. `estimated_cost_usd` is null for Token Plan runs; historical V1 artifacts with an older cost estimate remain readable. Requested model IDs and reasoning levels remain central; an unavailable provider-reported model ID is null.

The verified runtime pins are `rejudge@0.4.1` and `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at `0.85.1`. The Pi root-confinement patch remains required and is checked before model execution.

## Reruns and publication recovery

Review identity includes repository, PR number, base SHA, head SHA, Linear issue key and exact engine SHA.

- `UNABLE_TO_REVIEW` with the same identity may be manually rerun after the underlying problem is corrected.
- `PASS` or `BLOCK` with the same identity reuses canonical state. Reruns do not provide a stochastic model reroll.
- For a publication-only failure, rerun the failed publisher job. It downloads the existing canonical artifact from the same run and republishes without model calls. If presentation warnings occurred after a successful machine check, rerun that publisher job to repair presentation. Exact-head validation still applies. Rerunning the whole review with the same PASS/BLOCK identity also reuses state.
- A stale review creates no current result. Pushes that change the head require a new exact-head review.
- If canonical upload fails, the workflow fails and publisher does not run. No fabricated `AI PR Review` check or `STATE_PERSIST_FAILED` result is published for that attempt.

The only uploaded file is `ai-pr-review/out/ai-review-state-v1.json`, retained for 90 days as `ai-review-state-v1-pr-<number>`. Private Linear context, CI logs, prompts, model sessions and worker runtime stay on the review runner and are cleaned after the upload attempt, including failure paths. Expired or unavailable artifacts cannot serve as publication recovery input; do not reconstruct canonical state from comments or checks.

## Advisory rollout and false positives

Stage 1 is informational: leave `AI PR Review` out of required merge checks. Stage 2 requires separate per-repository calibration and an authorized rollout decision; this workflow does not change rulesets.

For a false-positive `BLOCK` in Stage 2, an authorized human may use the repository ruleset bypass and record the reason through the normal review process. The AI result remains red. No automation token may use bypass, force-pass the AI result, or modify rulesets to evade it.

Real-model smoke verification and the GitHub E2E fixture lifecycle are separate promotion gates. Local workflow tests do not establish that those live checks have passed.
