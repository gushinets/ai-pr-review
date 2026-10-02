# AI PR Review operations

## V2 operator checklist

Consumers install the GitHub App, select repositories and comment `/ai-review`
on an open PR. Write, maintain or admin access is required. No consumer
workflow, provider secret, Linear credential, PAT or config is required.

The following production setup requires the account owner:

1. Register an App using `app/manifest.json`, replacing the homepage and webhook
   placeholders with operator URLs. Generate its private key and webhook secret.
   Install it on the central execution repository and selected target repositories.
2. Deploy `app/Dockerfile` behind HTTPS. Mount a persistent, private `/data`
   volume for SQLite; preserve it across gateway restarts. Configure the gateway
   variables below. Forward POST `/webhook` and POST `/completion`; do not expose
   the ledger or private key. Set GitHub's webhook URL to `/webhook`.
3. Protect the central default branch. Set repository variable `AI_REVIEW_APP_ID`
   and `AI_REVIEW_GATEWAY_URL` (the HTTPS origin). Set central secrets
   `AI_REVIEW_APP_PRIVATE_KEY`, `QWEN_TOKEN_PLAN_API_KEY` and
   `AI_REVIEW_COMPLETION_SECRET`. The completion secret must match the gateway.
   Optional Linear experiments also need `LINEAR_CLIENT_ID` and
   `LINEAR_CLIENT_SECRET`. Consumers store none of these.
4. Complete the live acceptance sequence below before retiring V1 or changing
   merge rules. This implementation does not register an App, deploy production,
   provision secrets or claim that live acceptance has passed.

Gateway environment:

| Variable                                                  | Purpose                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `GITHUB_APP_ID`                                           | Registered App's numeric ID                                        |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE` | PEM key; prefer a private mounted file                             |
| `GITHUB_WEBHOOK_SECRET`                                   | Raw webhook HMAC verification                                      |
| `AI_REVIEW_COMPLETION_SECRET`                             | Independent HMAC key for central completion callbacks              |
| `AI_REVIEW_CENTRAL_REPOSITORY`                            | Execution repository, e.g. `gushinets/ai-pr-review`                |
| `AI_REVIEW_CENTRAL_WORKFLOW`                              | Optional; defaults to `central-ai-pr-review.yml`                   |
| `AI_REVIEW_CENTRAL_REF`                                   | Optional; defaults to `main`; must be the protected default branch |
| `AI_REVIEW_LEDGER_PATH`                                   | Persistent SQLite file, e.g. `/data/commands.sqlite`               |
| `PORT`                                                    | Optional; defaults to 3000                                         |

Build the gateway from the repository root:

```bash
docker build -f app/Dockerfile -t ai-pr-review-gateway .
```

The gateway runs as `node` on Node 22.19.0. Give that user write access to the
ledger directory. Back up SQLite consistently; do not delete command tombstones
to retry reviews. A signed comment ID remains consumed even if its unsigned
delivery header changes. Exact command claims also prevent simultaneous reviews
of one base/head. Network ambiguity keeps the claim until reconciled; an operator
must inspect the central run before changing the ledger.

### App permissions and credential boundaries

The App needs metadata read, contents read, pull requests write, issues read,
checks write, commit statuses read and Actions write. Issues read permits the
issue-comment subscription; publication uses PR endpoints. Actions write is
needed only to dispatch the central workflow. No issues write permission is used.

Every installation token is narrowed to one verified repository. Read tokens
receive metadata, contents, pull requests, checks, statuses and Actions read.
Publisher tokens receive metadata read plus pull requests/checks write. Dispatch
tokens receive metadata read and Actions write. Installation identity, App
ownership, repository access, permissions, suspension and token scope are checked
through GitHub; no installation or user IDs are fixed in code.

The central workflow checks out its exact engine SHA on the default branch.
Preparation receives only target read access, central artifact read access and
optional Linear secrets. Execution receives a read token for stale validation
and the provider key; the confined model subprocess receives only its isolated
review root, trusted runtime and provider credential. The App key, Linear secrets
and all GitHub tokens are absent from that subprocess. Publisher runs in a fresh
job with only sanitized state and a scoped write token. Completion runs in another
fresh job with only sanitized state and its HMAC secret. No phase executes target
source, installs target dependencies or loads HEAD instructions.

### Optional config and requirements

V2 loads `.github/ai-review.yml` only from BASE. Missing config selects empty
policy and central CI label `CI`; existing invalid config fails closed. The V1
schema remains `{version: 1, primary_ci_workflow, policy: {always, scoped}}`.
Configured policy files retain their existing BASE-only validation. Do not guess
policy files when config is absent.

The gateway currently requests `requirementsSource: {kind: "none"}` explicitly.
Trusted internal/manual requests may select
`{kind: "linear", identifier: "ANY-123"}` with centrally supplied Linear secrets.
No Linear lookup or PR issue-key prerequisite exists for `none`. Linear remains
private normative evidence and cannot issue reviewer instructions. The nullable
Linear identity is backward compatible with historical V1 state.

### State, retries and publication

Canonical artifacts live in the execution repository, named
`ai-review-state-v2-<repository-digest>-pr-<number>`. They contain only sanitized
`ai-review-state-v1.json` and are retained for 90 days. Discovery verifies the
central workflow, default branch, dispatch event, run engine SHA and target
identity. Target artifacts and PR comments cannot supply canonical state.

Completed same-base/head/engine PASS or BLOCK is reused without model calls.
Blocker history survives corrections. Every review checks current base/head and
open state before persistence and again before publication. Stale attempts cannot
replace the current result. App ownership identifies Check Runs and bot comments.
The stable summary is updated and previous inline blockers are closed by the
existing publisher.

After canonical upload and successful publication, a purpose-separated signed
callback retains the gateway claim. A terminal execution/publication failure
releases only that original identity claim, allowing a **new** `/ai-review`
comment to retry. Signed comment/delivery tombstones remain, so replaying an old
webhook or callback cannot release a later claim. If state was already persisted,
publication recovery reuses it without rerolling. Callback failure requires
operator reconciliation; retry the completion job after repairing HTTPS/secrets.

### CodeGraph and comparison

Normal App requests select graph `off`. A trusted central `workflow_dispatch`
may select `graphMode: "codegraph"`. The pinned `@colbymchenry/codegraph@1.6.1`
processor runs over a fresh exact HEAD snapshot in a nonroot, network-disabled,
read-only container. Source is inert; target CodeGraph configuration, indexes
and ignore files are not loaded. Limits cover time, memory, processes, input,
output, graph traversal and dynamic-boundary scans. Failed graph generation
records a fixed failure code and falls back to ordinary review.

Dispatch the same validated request with `compare: true` to run both `off` and
`codegraph` as fresh private shadows, including when production state is cached.
Neither arm publishes or changes production state. An explicit shadow request
requires a safe `experimentId`; the workflow comparison defaults it to run ID.
Shadow state uses the separate `ai-review-experiment-v2-*` namespace. Aggregate
`ai-review-telemetry-<run>-<arm>` artifacts record target/base/head/engine, variant,
model panel, finding/blocker counts, tokens (null if unavailable), latency and
graph status. Private requirements, raw sessions and CI logs are never uploaded.
Compare with known human findings/material regressions; extra findings do not
prove usefulness. An ordinary canonical request selects one production variant.

For a trusted operator experiment, save a `ReviewRequest` JSON with
`trigger: {kind: "internal", actor: "YOUR_GITHUB_LOGIN"}`, the target repository,
PR number and exact current base/head/baseBranch from GitHub. Set
`schema_version: 2`, `requirementsSource: {kind: "none"}`, `graphMode: "off"`
and `execution: "canonical"`; then dispatch both shadows:

```bash
gh workflow run central-ai-pr-review.yml --repo gushinets/ai-pr-review \
  --ref main --field request="$(cat request.json)" --field compare=true
```

Use the actual protected default branch if different. The workflow resolves the
target's installation through authenticated GitHub APIs and rechecks the actor's
write access and exact base/head. Internal requests do not create gateway claims
or completion callbacks. Set `requirementsSource` to the explicit Linear provider
when testing that evidence; credentials still come only from central secrets.

### Live acceptance evidence to collect

Run `test/promotion/app-e2e.test.ts` for the deterministic fake lifecycle first.
It covers signed command, central engine orchestration, exact-head BLOCK,
Check Run, stable summary, inline finding, correction, new command, blocker closure,
PASS and same-head reuse. It uses fake credentials/models and is not a live run.

On a real installed test repository with **no consumer workflow/config/secrets**:
open the broken fixture PR, comment as a write collaborator, record signed webhook
receipt and central run, then capture exact base/head, App-owned check, summary and
inline finding. Push the correction and post a new command; verify old blocker
closure and PASS. Record unauthorized/duplicate commands causing no model spend,
a push during review preventing stale publication, same-head reuse, and separate
graph shadows. Preserve URLs, exact engine SHA and operator evidence in an
acceptance record. Keep V1 and informational merge behavior until accepted.

## Legacy V1 operations

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
