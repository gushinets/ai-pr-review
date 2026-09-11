# AI PR Review operations

The reusable workflow runs trusted central code on Ubuntu 24.04 with Node 22.19.0. Every job checks out the called workflow repository at `job.workflow_sha` and verifies that exact engine identity. Consumer PR code is inert review evidence; its scripts, dependencies and local actions are never executed.

## Consumer setup

- Pin `gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml` to a full commit SHA. Updating that pin is an explicit reviewed change.
- Set repository secrets `QWEN_API_KEY`, `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, and forward each by name. Do not use `secrets: inherit`. The native ephemeral `GITHUB_TOKEN` is sufficient; no PAT is needed.
- Set the non-secret repository variable `ALIBABA_WORKSPACE_ID` and pass it as `alibaba_workspace_id`. It must identify the Germany (Frankfurt) Model Studio workspace with Global service deployment scope. The execute CLI validates its format before any model call; provider endpoints and models are fixed centrally.
- Add the strict `.github/ai-review.yml` and policy files consumed from the PR base SHA. Missing or invalid configuration produces `UNABLE_TO_REVIEW`.
- The caller must allow `actions: read`, `contents: read`, `statuses: read`, `pull-requests: write` and `checks: write`. Central preflight and review jobs reduce those permissions to read-only; only publisher gets write access. No `issues: write` permission is requested.
- Automatic callers use `mode: automatic` with the completed primary CI `triggering_run_id`; omit `pr_number`. Primary CI names are `baseline-backend` for Platform and `CI` for Payments, regardless of CI conclusion. Manual maintainer dispatch uses `mode: manual` with a positive `pr_number`; omit `triggering_run_id`. The CLI validates numeric IDs and authorization before any Linear or model credential is used.
- Configure caller concurrency for each repository/PR with `cancel-in-progress: true`. This belongs to the consumer workflows; do not reuse the same cancel group in a nested workflow. Exact-head barriers remain active before persistence and publication.

Preflight has no Linear or Qwen credentials. Prepare receives only read-only GitHub and Linear credentials; execute receives only read-only GitHub, Qwen and the workspace variable. Rejudge children use the existing explicit environment allowlist and `PI_OFFLINE=1`. Publisher receives only GitHub credentials and the current run's canonical state.

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
