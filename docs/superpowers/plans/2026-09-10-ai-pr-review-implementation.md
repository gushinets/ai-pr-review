# AI PR Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> If those named workflow skills are not installed in the local-agent environment, execute this plan directly task-by-task using the same TDD, verification, review, and commit gates. The skills are execution aids, not runtime dependencies of `ai-pr-review`.

**Goal:** Complete `gushinets/ai-pr-review` from the already-implemented Tasks 1-16 baseline, migrate its model runtime from the old Model Studio PAYG/Frankfurt contract to Alibaba Token Plan/Singapore, adopt the `rejudge@0.4.1` npm artifact after an explicit compatibility gate, then finish calibration, live promotion, GitHub E2E, Stage-1 consumer rollout, and acceptance evidence.

**Architecture:** Consumer repositories remain thin `workflow_run`/`workflow_dispatch` callers with base-SHA declarative policy. The central repository owns deterministic preflight/context construction, a hardened Rejudge execution phase backed by Pi's built-in international `qwen-token-plan` provider, artifact-backed state/history, and a separate publisher phase with GitHub write permission but no model/Linear credentials. Model output never directly determines a GitHub verdict or side effect.

**Tech Stack:** Node.js 22.19.0, TypeScript 5.9.3, npm, target `rejudge@0.4.1` exact npm artifact, Pi `0.85.1` exact packages as the preferred migration baseline pending the Task 16A compatibility gate, `@linear/sdk` 94.0.0, `@octokit/rest` 22.0.1, TypeBox 1.3.27, Vitest 4.1.9, OXLint 1.82.0, Prettier 3.9.6, `patch-package` 8.0.1, `tar-stream` 3.2.0, `fflate` 0.8.3, `yaml` 2.9.0, `minimatch` 10.2.6.

**Spec:** `docs/superpowers/specs/2026-09-10-ai-pr-review-design.md`

**Last synchronized:** 2026-09-12

**Precedence:** The design spec is authoritative for architecture and invariants. This plan is authoritative for execution ordering, concrete remaining files, tests, and commit boundaries. If implementation discovery proves a spec assumption technically impossible or materially unsafe, stop at that affected boundary and propose a narrowly scoped design amendment rather than weakening the invariant silently.

## Current Implementation Baseline

Tasks 1-16 from the original plan are already implemented on `main` and are the starting codebase for this synchronized continuation plan. Do **not** re-dispatch or reimplement Tasks 1-16 wholesale. Preserve their tested security, state, publishing, and exact-head behavior unless a Task 16A migration test demonstrates that a narrow change is required.

The old Task 1-16 implementation still contains the superseded provider contract in these live surfaces and therefore must be migrated before Task 17:

- `package.json` pins `rejudge@0.3.1` and Pi `0.85.1`;
- `src/config/central-config.ts` uses `model-studio/*` model IDs and `qwen3.8-max-0902@high`;
- `src/config/model-studio.ts` builds a Frankfurt workspace URL, accepts `ALIBABA_WORKSPACE_ID`, manually defines model metadata/reasoning maps, and reads `QWEN_API_KEY`;
- `src/sandbox/worker-env.ts` passes `QWEN_API_KEY`;
- `src/cli/review.ts` enforces the old `QWEN_API_KEY`/`ALIBABA_WORKSPACE_ID` process contract;
- `src/orchestration/review-pipeline.ts` accepts `workspaceId` and writes the custom Model Studio provider config;
- `.github/workflows/reusable-ai-pr-review.yml` exposes `alibaba_workspace_id` and `QWEN_API_KEY`;
- `ReviewStateV1.telemetry.models[].requested_reasoning` currently allows only `medium|high`, so it cannot represent the approved `qwen3.8-max@xhigh` judge without a backward-compatible schema extension.

All remaining work begins with Task 16A below.

## Global Constraints

- V1 is GitHub Actions only: no VPS, webhook service, database, queue, custom GitHub App, or persistent daemon.
- Initial consumers are `gushinets/anytoolai-platform` and `gushinets/payments-portal`.
- Primary CI workflow names are `baseline-backend` for Platform and `CI` for Payments.
- Automatic review requires PR author repository permission `write`, `maintain`, or `admin`; maintainer `workflow_dispatch` may explicitly authorize an external PR.
- Target PR code is never executed in the privileged AI-review path.
- Review behavior is controlled only by central code plus policy/config loaded from the PR base SHA.
- Linear title/description are normative requirements; Linear comments are supplementary; attachments/linked docs/sub-issues are not fetched in V1.
- Raw Linear text, raw failed CI logs, raw model transcripts, prompts, environment dumps, and credentials are never persisted in canonical artifacts or published to GitHub.
- Reviewer tools are read-only and root-bound. `bash`, `edit`, `write`, web search, Rejudge `--unsafe`, and Rejudge `--full` are prohibited.
- Pi is an internal Rejudge runtime dependency only; only `src/review-engine/**` and `src/sandbox/**` may import `@earendil-works/pi-*` packages.
- V1 inference channel is only Alibaba Model Studio Token Plan through Pi's built-in international `qwen-token-plan` provider.
- Token Plan endpoint is fixed centrally to `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` and is not a consumer input.
- Token Plan credential is only `QWEN_TOKEN_PLAN_API_KEY`; the engine validates the `sk-sp-` prefix before a provider call. Legacy `QWEN_API_KEY`, Qwen Code's `BAILIAN_TOKEN_PLAN_API_KEY`, and `ALIBABA_WORKSPACE_ID` are not production runtime inputs.
- Fixed panel: reviewer 1 `qwen-token-plan/qwen3.8-flash@medium`; reviewer 2 `qwen-token-plan/deepseek-v4-pro-0813@high`; reviewer 3 `qwen-token-plan/glm-5.2@high`; judge `qwen-token-plan/qwen3.8-max@xhigh`.
- `deepseek-v4-pro-0813` may be centrally merged into generic `qwen-token-plan` only from compatibility metadata verified against the selected pinned Pi Token Plan catalog.
- Do not copy Qwen Code `modelProviders`, `generationConfig`, `extra_body`, `thinkingMandatory`, modality declarations, or `providerMetadata` into Pi config.
- Capability/context metadata comes from the selected pinned Pi catalog. Central overrides are limited to the approved snapshot merge and max output ceilings unless the spec is amended.
- Strict technical quorum is 3/3 reviewers plus judge; no degraded quorum and no hidden fallback model.
- No fallback to PAYG, Coding Plan, another endpoint, another API key, another provider, or substitute model.
- Reviewer max output is 32k tokens each; judge max output is 24k; each production AI review has a 20-minute deadline.
- Pre-model ceilings: 250 changed files, 20,000 additions+deletions, 128 KiB normalized Linear context.
- Judge output is strict `JudgeResultV1`; unknown fields are rejected; a model-supplied `verdict` is invalid; maximum findings is 20; `blocking` requires `high` confidence.
- Exactly one judge-only same-run repair is allowed after invalid judge JSON/schema. No wrapper-level whole-panel retry.
- Fresh verdict: zero blocking findings -> `PASS`; at least one blocking finding -> `BLOCK`; protocol/system/provider failure -> `UNABLE_TO_REVIEW`.
- Previous blockers are shown only in a second closure phase after the fresh review; `uncertain` historical closure with no fresh blockers -> `UNABLE_TO_REVIEW`.
- `ReviewIdentityV1` remains repository + PR number + base SHA + head SHA + Linear issue key + exact engine SHA. Provider-side model revision is not part of identity.
- Same-identity canonical `PASS`/`BLOCK` is reused and never rerolled. Same-identity `UNABLE_TO_REVIEW` may rerun.
- GitHub Actions artifact is canonical state; comments/checks are presentation only; artifact retention is 90 days.
- Machine check name is exactly `AI PR Review` and is attached only to the exact reviewed PR head SHA.
- Token Plan model-visible context is intentionally processed through the Singapore international endpoint, including selected private Linear requirements/comments.
- Bot review event is `COMMENT` only. It never publishes `APPROVE` or `REQUEST_CHANGES`.
- `STALE_SKIPPED` publishes no current verdict.
- Central reusable workflow is referenced from consumers by full commit SHA, never mutable `@main`.
- Secrets are forwarded explicitly; never use `secrets: inherit`.
- Review/model process never receives GitHub write credentials; publisher never receives Token Plan/Linear credentials or raw review context.
- Token Plan Credits are provider/subscription accounting. V1 does not infer per-review Credits from token counts and does not present PAYG dollar estimates as Token Plan spend.
- Stage 1 is informational; Stage 2 adds the same `AI PR Review` check to required checks only after per-repository calibration.
- Central/reusable AI-review jobs run on `ubuntu-24.04`. Install `ripgrep` and `fd-find` before any secret-bearing model step; Rejudge/Pi workers remain `PI_OFFLINE=1`.

## Remaining Repository/File Map

```text
package.json
package-lock.json
patches/
  @earendil-works+pi-coding-agent+<PIN>.patch   # stays 0.85.1 if compatibility gate passes
src/
  config/
    central-config.ts
    repo-config.ts
    # delete superseded model-studio.ts after Task 16A
  contracts/
    failure-reasons.ts
    review-state.ts
  sandbox/
    worker-env.ts
    pi-confinement-contract.ts
  review-engine/
    token-plan-config.ts            # Pi-native provider/catalog compatibility + models.json writer
    rejudge-extension.ts
    rejudge-worker.ts
    rejudge-engine.ts
  orchestration/
    review-pipeline.ts
    calibration.ts                  # Task 17
  cli/
    review.ts
    calibration-report.ts           # Task 17
    promotion-smoke.ts              # Task 18
  publishing/
    summary.ts
.github/workflows/
  reusable-ai-pr-review.yml
  promotion-smoke.yml               # Task 18
fixtures/
  smoke/                            # Task 18
  github-e2e/                       # Task 19
test/
  config/
  contracts/
  sandbox/
  review-engine/
  orchestration/
  cli/
  workflows/
  promotion/
docs/
  operations.md
  calibration.md
  stage1-acceptance.md
```

---

### Task 16A: Migrate the Existing Runtime to Token Plan and Rejudge 0.4.1

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config/central-config.ts`
- Delete after replacement: `src/config/model-studio.ts`
- Create: `src/review-engine/token-plan-config.ts`
- Modify: `src/contracts/failure-reasons.ts`
- Modify: `src/contracts/review-state.ts`
- Modify: `src/sandbox/worker-env.ts`
- Modify as required by compatibility probe: `src/review-engine/rejudge-extension.ts`
- Modify as required by compatibility probe: `src/review-engine/rejudge-worker.ts`
- Modify: `src/orchestration/review-pipeline.ts`
- Modify: `src/cli/review.ts`
- Modify: `.github/workflows/reusable-ai-pr-review.yml`
- Modify: `docs/operations.md`
- Test: `test/config/central-config.test.ts`
- Replace/rename: `test/config/model-studio.test.ts` -> `test/review-engine/token-plan-config.test.ts`
- Modify: `test/contracts/review-state.test.ts`
- Modify: `test/sandbox/worker-env.test.ts`
- Modify: `test/review-engine/rejudge-extension.test.ts`
- Modify: `test/review-engine/rejudge-engine.test.ts`
- Modify: `test/orchestration/review-pipeline.test.ts`
- Modify: `test/cli/review.test.ts`
- Modify: `test/workflows/reusable-ai-pr-review.test.ts`
- Modify if Pi pin changes: `patches/@earendil-works+pi-coding-agent+<PIN>.patch`

**Interfaces:**
- Consumes: approved Token Plan spec, existing Tasks 1-16 implementation, `QWEN_TOKEN_PLAN_API_KEY`, exact npm package `rejudge@0.4.1`.
- Produces: the same public review pipeline contract, but with no workspace input, Pi-native Token Plan provider semantics, the approved model panel, a verified Rejudge/Pi runtime pair, backward-compatible V1 state parsing, and a green deterministic/security suite.

- [ ] **Step 1: Lock the new central model constants in failing tests**

Update/add tests first so `CENTRAL_CONFIG` must equal:

```ts
reviewers: [
  { model: "qwen-token-plan/qwen3.8-flash", level: "medium", maxTokens: 32_768 },
  { model: "qwen-token-plan/deepseek-v4-pro-0813", level: "high", maxTokens: 32_768 },
  { model: "qwen-token-plan/glm-5.2", level: "high", maxTokens: 32_768 },
]
judge: { model: "qwen-token-plan/qwen3.8-max", level: "xhigh", maxTokens: 24_576 }
```

Also assert no central model/provider string contains `model-studio`, `qwen3.8-max-0902`, `eu-central-1`, or `ALIBABA_WORKSPACE_ID`.

Run:

```bash
npm test -- test/config/central-config.test.ts
```

Expected before implementation: FAIL on old `model-studio/*`/judge values.

- [ ] **Step 2: Add a durable Rejudge 0.4.1 compatibility contract before changing the package**

Extend the existing Rejudge extension/engine tests to assert the production wrapper requirements rather than internal implementation trivia:

```text
installed package version == 0.4.1
shipped programmatic extension can be resolved from the installed npm artifact
loadRejudgeTool() captures one `rejudge` tool
fresh execution returns answer + run id through the existing worker protocol
resume accepts the same run id and runtime directory
run id is validated rather than trusted blindly
reviewer tool surface remains read/grep/find/ls/git_diff only
judge path still supports ask_panel
no test or runtime path enables --unsafe or --full
Pi confinement attestation runs before the first model request
```

Do not weaken the root-confinement patch or switch to the opaque bundled Rejudge CLI merely to make `0.4.1` pass.

- [ ] **Step 3: Upgrade only Rejudge first and verify Pi 0.85.1 compatibility**

Change direct dependency:

```json
"rejudge": "0.4.1"
```

Keep these exact pins initially:

```json
"@earendil-works/pi-coding-agent": "0.85.1",
"@earendil-works/pi-tui": "0.85.1"
```

Add direct dependency because Task 16A reads the pinned Pi provider catalog deliberately rather than relying on a transitive package:

```json
"@earendil-works/pi-ai": "0.85.1"
```

Regenerate the lockfile using the normal npm install path, then run:

```bash
npm ci
npm test -- test/review-engine/rejudge-extension.test.ts test/review-engine/rejudge-engine.test.ts test/security
```

**Gate:** if `rejudge@0.4.1` installs and these tests pass with Pi `0.85.1`, Pi `0.85.1` becomes the final V1 pin. If `0.4.1` cannot operate with `0.85.1`, stop Task 16A at this boundary. Inspect the exact `0.4.1` npm artifact/peer requirements and amend this plan with one exact replacement Pi version; do not float `latest`, use a range, or continue with an unverified Pi upgrade.

- [ ] **Step 4: Implement the Pi-native Token Plan runtime contract**

Create `src/review-engine/token-plan-config.ts`. This file is allowed to import Pi because it lives under `src/review-engine/**`.

Export exact constants:

```ts
export const TOKEN_PLAN_PROVIDER_ID = "qwen-token-plan" as const;
export const TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" as const;
export const TOKEN_PLAN_API_KEY_ENV = "QWEN_TOKEN_PLAN_API_KEY" as const;
```

Expose:

```ts
export function assertTokenPlanRuntimeContract(): void;
export async function writeTokenPlanConfig(runtimeDir: string): Promise<void>;
```

`assertTokenPlanRuntimeContract()` must read the selected pinned Pi catalog and fail closed unless all are true:

```text
provider `qwen-token-plan` exists
provider base URL == fixed Singapore URL
provider API == openai-completions
native qwen3.8-flash exists
native glm-5.2 exists
native qwen3.8-max exists
qwen3.8-flash supports medium reasoning
qwen3.8-max supports xhigh reasoning
qwen-token-plan-individual/deepseek-v4-pro-0813 exists as the compatibility source for the exact snapshot
```

The runtime config must **not** redefine provider base URL/auth/API. Write only a `providers.qwen-token-plan` entry containing:

1. `modelOverrides` for native models:

```json
{
  "qwen3.8-flash": { "maxTokens": 32768 },
  "glm-5.2": { "maxTokens": 32768 },
  "qwen3.8-max": { "maxTokens": 24576 }
}
```

2. one merged custom model `deepseek-v4-pro-0813`, derived from the selected pinned Pi Individual Token Plan catalog entry. Copy only Pi `models.json`-supported capability fields required to preserve its exact API/reasoning/tool compatibility (`id`, `name` when present, `api`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `samplingParams` when present, `headers` when present, `compat` when present), and set `maxTokens: 32768`. Do not hard-code a synthetic 1M context window or hand-written reasoning map when the pinned Pi catalog supplies the value.

The generated file must contain no API-key literal and no Qwen Code `generationConfig`, `extra_body`, `thinkingMandatory`, video modality, provider metadata hashes, or PAYG cost model.

- [ ] **Step 5: Test the Token Plan config as an allowlist, not a mirror of Qwen Code**

`test/review-engine/token-plan-config.test.ts` must assert:

```text
fixed provider id/base URL/API from pinned Pi
QWEN_TOKEN_PLAN_API_KEY is the only accepted model credential name
three native model IDs exist
merged deepseek-v4-pro-0813 metadata matches the selected Pi Individual catalog for supported compatibility fields
maxTokens are 32768/32768/32768/24576
judge level xhigh is supported natively
no `model-studio`, Frankfurt URL, workspace id, legacy QWEN_API_KEY, BAILIAN_TOKEN_PLAN_API_KEY, generationConfig, extra_body, thinkingMandatory or qwen3.8-max-0902 appears in generated config
```

Run:

```bash
npm test -- test/review-engine/token-plan-config.test.ts test/config/central-config.test.ts
```

- [ ] **Step 6: Migrate the worker secret boundary**

Change `buildWorkerEnv()` so it requires `QWEN_TOKEN_PLAN_API_KEY`, rejects a missing/blank key and rejects any key not matching:

```regex
^sk-sp-[A-Za-z0-9._-]+$
```

Use failure code `PROVIDER_CONFIG_INVALID` before the first provider call. The child environment contains `QWEN_TOKEN_PLAN_API_KEY` and never inherits:

```text
QWEN_API_KEY
BAILIAN_TOKEN_PLAN_API_KEY
ALIBABA_WORKSPACE_ID
GITHUB_TOKEN
LINEAR_CLIENT_ID
LINEAR_CLIENT_SECRET
arbitrary *_TOKEN / *_SECRET / *_KEY values
```

Keep the existing safe `HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`, `TMPDIR`, root/runtime vars, search-tool PATH, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0` behavior.

- [ ] **Step 7: Extend state/telemetry without breaking old V1 artifacts**

In `ReviewStateV1.telemetry.models[]`:

```ts
requested_reasoning: "medium" | "high" | "xhigh";
provider_reported_model_id?: string | null;
```

Keep `model_id` as the centrally requested provider/model identifier. The new provider-reported field is optional so existing V1 artifacts created before the migration still parse.

Add provider-aware unable reasons:

```ts
"PROVIDER_CONFIG_INVALID"
"PROVIDER_AUTH_FAILED"
"PROVIDER_RATE_LIMITED"
"PROVIDER_QUOTA_EXHAUSTED"
"PROVIDER_UNAVAILABLE"
```

Update identity/CI-required reason sets consistently. New Token Plan state writes `estimated_cost_usd: null`; do not reject historical V1 artifacts solely because they contain an old non-null estimate.

Add tests for old-state compatibility and a new state with judge `requested_reasoning: "xhigh"`.

- [ ] **Step 8: Classify provider failures without persisting raw provider bodies**

Keep existing Rejudge panel/judge/resume stages. Add a bounded in-memory classifier for technical provider failures. It may map only evidence available from the exact `rejudge@0.4.1` worker error contract:

```text
local key/provider contract failure -> PROVIDER_CONFIG_INVALID
401/403 or explicit auth code -> PROVIDER_AUTH_FAILED
429 without explicit quota/credits exhaustion -> PROVIDER_RATE_LIMITED
explicit quota/credits/resource-exhausted signal -> PROVIDER_QUOTA_EXHAUSTED
provider 5xx/network/timeout/unclassified provider availability failure -> PROVIDER_UNAVAILABLE
```

Never persist the raw response body, headers containing credentials, or an entire exception string. If a Rejudge failure cannot be identified as provider-originated safely, retain the existing `REJUDGE_PANEL_FAILED`, `REJUDGE_JUDGE_FAILED`, `JUDGE_REPAIR_FAILED`, or `CLOSURE_FAILED` reason instead of guessing.

Write tests with synthetic sanitized error shapes only; no live key is required.

- [ ] **Step 9: Remove workspace routing from orchestration and CLI**

Replace `writeModelStudioConfig()` with `assertTokenPlanRuntimeContract()` + `writeTokenPlanConfig(runtimeDir)` in the execute phase.

`ExecuteDependencies` no longer contains `workspaceId`.

`src/cli/review.ts` process contracts become:

```text
prepare:
  requires GITHUB_TOKEN + LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET
  forbids QWEN_TOKEN_PLAN_API_KEY, legacy QWEN_API_KEY, BAILIAN_TOKEN_PLAN_API_KEY, ALIBABA_WORKSPACE_ID

execute:
  requires GITHUB_TOKEN + QWEN_TOKEN_PLAN_API_KEY
  forbids LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET, legacy QWEN_API_KEY, BAILIAN_TOKEN_PLAN_API_KEY, ALIBABA_WORKSPACE_ID

emit-preflight-unable:
  requires GITHUB_TOKEN only
  forbids every model/Linear credential above
```

The Rejudge child still must not receive `GITHUB_TOKEN`.

- [ ] **Step 10: Migrate the reusable workflow contract**

Delete reusable-workflow input:

```yaml
alibaba_workspace_id
```

Replace secret:

```yaml
QWEN_API_KEY
```

with:

```yaml
QWEN_TOKEN_PLAN_API_KEY:
  required: true
```

The execute step passes only:

```yaml
env:
  GITHUB_TOKEN: ${{ github.token }}
  QWEN_TOKEN_PLAN_API_KEY: ${{ secrets.QWEN_TOKEN_PLAN_API_KEY }}
```

plus the existing non-secret review identity fields. There is no Alibaba workspace variable anywhere in the reusable workflow.

Update semantic workflow tests to assert:

```text
no alibaba_workspace_id input
no ALIBABA_WORKSPACE_ID expression
no QWEN_API_KEY expression
no BAILIAN_TOKEN_PLAN_API_KEY expression
QWEN_TOKEN_PLAN_API_KEY appears only in the execute secret-bearing step, never preflight/publisher/job-level env
secrets: inherit absent
publisher contains no Token Plan/Linear secret
existing exact-central-checkout, permissions, state upload, stale and 20-minute gates remain unchanged
```

- [ ] **Step 11: Update operations documentation and delete the superseded provider module**

`docs/operations.md` must say:

```text
consumer secrets = QWEN_TOKEN_PLAN_API_KEY, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET
no ALIBABA_WORKSPACE_ID variable
Token Plan endpoint/provider are central constants
Token Plan key must be sk-sp-...
provider/quota failure -> UNABLE_TO_REVIEW, no PAYG/Coding Plan fallback
Credits are checked in Alibaba subscription usage; estimated_cost_usd is null for Token Plan runs
Singapore is the accepted inference region for model-visible review context
```

After all imports/tests use `token-plan-config.ts`, delete `src/config/model-studio.ts` and its old test.

- [ ] **Step 12: Run the complete migration verification**

Run exactly:

```bash
npm ci
npm test -- test/config/central-config.test.ts \
  test/review-engine/token-plan-config.test.ts \
  test/contracts/review-state.test.ts \
  test/sandbox/worker-env.test.ts \
  test/review-engine/rejudge-extension.test.ts \
  test/review-engine/rejudge-engine.test.ts \
  test/orchestration/review-pipeline.test.ts \
  test/cli/review.test.ts \
  test/workflows/reusable-ai-pr-review.test.ts
npm run test:security
npm run check
npm run build
```

Before claiming completion, verify repository status contains only intended Task 16A changes and no generated/private runtime data.

- [ ] **Step 13: Commit the migration as one task boundary**

```bash
git add package.json package-lock.json patches src test .github/workflows/reusable-ai-pr-review.yml docs/operations.md
git commit -m "feat: migrate review runtime to Token Plan"
```

**Completion report must include:** final Rejudge version, final exact Pi versions, whether Pi `0.85.1` passed unchanged, tests/checks run, commit SHA, and any compatibility deviation from the approved preferred baseline.

---

### Task 17: Add Calibration Reporting and Stage-1 Feedback Collection

**Files:**
- Create: `src/orchestration/calibration.ts`
- Create: `src/cli/calibration-report.ts`
- Create: `test/orchestration/calibration.test.ts`
- Create: `docs/calibration.md`
- Modify: `src/publishing/summary.ts`

**Interfaces:**
- Consumes: canonical review artifacts, AI summary/inline reactions, PR timelines, workflow timing, maintainer permission lookup.
- Produces: per-repository calibration report only; it never changes rulesets automatically and never converts Token Plan tokens into invented dollar/Credit spend.

- [ ] **Step 1: Define the Token Plan-aware report contract in a failing test**

Implement:

```ts
export interface CalibrationReportV1 {
  schema_version: 1;
  repository: string;
  completed_live_reviews: number;
  evaluated_blocking_cases: number;
  completed_review_rate: number;
  unable_rate: number;
  false_block_rate: number | null;
  blocking_finding_precision: number | null;
  material_miss_rate: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  token_usage_samples: number;
  provider_failures: {
    config_invalid: number;
    auth_failed: number;
    rate_limited: number;
    quota_exhausted: number;
    unavailable: number;
  };
  known_security_boundary_violations: number;
  stage2_criteria_met: boolean;
}
```

Exclude `STALE_SKIPPED` from reliability denominators. Count only reactions/comments from users whose repository permission at evaluation time is `write`, `maintain`, or `admin`.

- [ ] **Step 2: Define feedback semantics exactly**

Summary verdict reaction:

```text
👍 = maintainer says PR-level AI verdict is correct
👎 = maintainer says PR-level AI verdict is incorrect
```

Inline blocking finding:

```text
👍 = finding valid
👎 = false positive
```

Material miss after AI PASS requires an authorized user's exact marker:

```html
<!-- ai-pr-review-material-miss:v1:<40-hex-head-sha> -->
```

Do not infer misses from arbitrary discussion prose.

- [ ] **Step 3: Implement exact Stage 1 -> Stage 2 criteria**

`stage2_criteria_met` is true only when:

```text
completed_live_reviews >= 25
evaluated_blocking_cases >= 10
false_block_rate != null && false_block_rate <= 0.05
blocking_finding_precision != null && blocking_finding_precision >= 0.90
material_miss_rate != null && material_miss_rate <= 0.10
completed_review_rate >= 0.95
unable_rate <= 0.05
p95_latency_ms != null && p95_latency_ms <= 15 minutes
known_security_boundary_violations == 0
```

Provider failure counts are diagnostic breakdowns of UNABLE outcomes; they are not a separate hidden Stage-2 formula. Repeated quota/concurrency failures must still be visible in the report for the engineering-owner decision.

- [ ] **Step 4: Remove PAYG dollar alerts from calibration**

Do not calculate or render `median_cost_usd`/`p95_cost_usd` warnings. Sum token usage only from non-null usage fields. State explicitly in `docs/calibration.md`:

```text
Token Plan Credits are authoritative in Alibaba subscription usage.
This report does not infer Credits or PAYG dollar spend from token counts.
```

- [ ] **Step 5: Implement CLI output**

Command:

```bash
npm run cli:calibration -- --repository gushinets/payments-portal
```

Print concise Markdown and optionally write strict JSON with `--json-out PATH`. Show every Stage-2 criterion, provider-failure breakdown, token totals, and:

```text
Engineering-owner approval is still required before changing required checks.
```

- [ ] **Step 6: Update Stage-1 summary feedback copy**

Keep the stable summary marker. Explain 👍/👎 semantics and the material-miss marker without adding verdict-changing buttons or automation.

- [ ] **Step 7: Verify and commit**

```bash
npm test -- test/orchestration/calibration.test.ts test/publishing/summary.test.ts
npm run check
npm run build
git status --short
git add src/orchestration/calibration.ts src/cli/calibration-report.ts src/publishing/summary.ts test/orchestration/calibration.test.ts test/publishing/summary.test.ts docs/calibration.md
git commit -m "feat: report ai review calibration"
```

---

### Task 18: Add Real Token Plan Promotion Smokes and Security Release Gates

**Files:**
- Create: `fixtures/smoke/good/base/calculator.ts`
- Create: `fixtures/smoke/good/head/calculator.ts`
- Create: `fixtures/smoke/good/requirements.json`
- Create: `fixtures/smoke/bad/base/calculator.ts`
- Create: `fixtures/smoke/bad/head/calculator.ts`
- Create: `fixtures/smoke/bad/requirements.json`
- Create: `src/cli/promotion-smoke.ts`
- Create: `.github/workflows/promotion-smoke.yml`
- Create: `test/promotion/promotion-smoke-contract.test.ts`
- Modify: `package.json`
- Modify if required for reusable production-path hooks only: `src/orchestration/review-pipeline.ts`

**Interfaces:**
- Consumes: `QWEN_TOKEN_PLAN_API_KEY`, fixed local fixtures, the exact production Rejudge/Pi/provider/runtime modules.
- Produces: promotion evidence that one exact engine candidate SHA works with the real Token Plan stack; performs no production GitHub publishing.

- [ ] **Step 1: Create tiny deterministic good/bad fixture pairs**

Bad HEAD:

```ts
export function subtract(a: number, b: number): number {
  return a + b;
}
```

Bad requirements:

```json
{
  "identifier": "SMOKE-BAD",
  "title": "Implement subtraction",
  "description": "subtract(a, b) must return a - b for ordinary numeric inputs.",
  "comments": []
}
```

Good HEAD implements `return a - b`. Keep each source fixture below 20 lines.

- [ ] **Step 2: Write the deterministic promotion contract test first**

Assert `promotion-smoke.ts` reuses production modules for:

```text
review-root/snapshot layout
precomputed git-diff shim
Token Plan config/runtime assertion
Pi confinement
Rejudge fresh/resume engine
strict JudgeResultV1 parser
verdict computation
historical closure parser
```

Assert it never imports/calls GitHub publisher code and accepts no provider URL/workspace/model override arguments.

- [ ] **Step 3: Implement the live smoke scenarios through the production stack**

The command must run these scenarios with the same exact runtime/model panel as production:

```text
good: fresh review -> schema-valid PASS
bad: fresh review -> >=1 high-confidence blocking finding -> BLOCK
repair: first judge output intentionally constrained to invalid JSON, then same-run resume with normal strict output -> valid JudgeResultV1
closure: seed one previous blocker against the corrected fixture, then fresh review + current-run resume -> resolved|invalidated and final PASS
```

For the repair scenario, use a smoke-only output instruction that deterministically requests a non-JSON first judge answer, then invoke the normal production repair prompt on the same run. Do not add a production code branch that intentionally corrupts output.

The deterministic unit suite continues to cover second-invalid-result -> `UNABLE_TO_REVIEW`; the live smoke must at minimum prove one real same-run resume repair and one real closure resume.

Sanitized output may contain only:

```text
fixture/scenario
requested model IDs
requested/effective reasoning when available
PASS/BLOCK/UNABLE outcome
review duration
input/output token counts when returned
provider failure category when applicable
```

Never print raw transcripts or reasoning content. `estimated_cost_usd` is not reported as Token Plan spend.

- [ ] **Step 4: Add explicit runtime/provider assertions to promotion acceptance**

Before real model calls, the smoke must assert:

```text
installed Rejudge version == 0.4.1
selected exact Pi version == the Task 16A final pin
Pi confinement attestation passes
provider id == qwen-token-plan
provider base URL == fixed Singapore endpoint
credential env == QWEN_TOKEN_PLAN_API_KEY
qwen3.8-flash, deepseek-v4-pro-0813, glm-5.2, qwen3.8-max are available through the final config
reviewer levels medium/high/high and judge xhigh are representable by the final Pi metadata
32k reviewer / 24k judge maxTokens are the active central ceilings
```

- [ ] **Step 5: Add the manual promotion workflow**

`.github/workflows/promotion-smoke.yml` uses `workflow_dispatch` only and `permissions: contents: read`. Pin checkout/setup-node actions exactly as central CI does. Use `ubuntu-24.04`.

Trusted bootstrap:

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends ripgrep fd-find
rg --version
fdfind --version
npm ci
npm run build
npm run test:security
npm run cli:promotion-smoke
```

Only the smoke command receives:

```yaml
QWEN_TOKEN_PLAN_API_KEY: ${{ secrets.QWEN_TOKEN_PLAN_API_KEY }}
```

There is no `ALIBABA_WORKSPACE_ID`, legacy `QWEN_API_KEY`, Linear secret, PAT, or GitHub write permission. Set a workflow timeout large enough to run the sequential smoke scenarios, while every individual production-engine invocation keeps the 20-minute review deadline.

Add script:

```json
"cli:promotion-smoke": "node dist/src/cli/promotion-smoke.js"
```

- [ ] **Step 6: Define fail-closed provider failure probes without consuming fallback channels**

The deterministic promotion contract tests must inject synthetic auth/rate-limit/quota/unavailable failures through the same Rejudge adapter boundary and assert:

```text
result = UNABLE_TO_REVIEW
expected provider failure category when safely classifiable
zero PAYG/Coding Plan/alternate-key/model fallback attempts
zero second whole-panel retry
```

Do not deliberately exhaust the real subscription quota in the live workflow.

- [ ] **Step 7: Run deterministic checks and commit Task 18**

```bash
npm test -- test/promotion/promotion-smoke-contract.test.ts
npm run test:security
npm run check
npm run build
git status --short
git add fixtures/smoke src/cli/promotion-smoke.ts .github/workflows/promotion-smoke.yml test/promotion package.json src/orchestration/review-pipeline.ts
git commit -m "test: add Token Plan promotion gate"
```

- [ ] **Step 8: Push and pass the real promotion workflow for the exact candidate SHA**

After the Task 18 commit is on the shared branch, set:

```bash
ENGINE_CANDIDATE_SHA="$(git rev-parse HEAD)"
test "${#ENGINE_CANDIDATE_SHA}" -eq 40
```

Dispatch `promotion-smoke.yml`, resolve the created workflow run, and require its `head_sha` to equal `ENGINE_CANDIDATE_SHA`. Do not promote a run from a different SHA.

Acceptance:

```text
deterministic CI green
security suite green
runtime/provider assertions green
real good = PASS
real bad = BLOCK with blocking finding
real same-run repair succeeds
real historical closure succeeds
no sandbox/secret leak observed
```

Freeze this exact `ENGINE_CANDIDATE_SHA` for Task 19 and consumer Tasks 20-21. If any required live scenario fails, Task 18 is incomplete.

---

### Task 19: Prove the Full GitHub Workflow in a Dedicated E2E Fixture Repository

**Files:**
- Central create: `fixtures/github-e2e/README.md`
- Create: `fixtures/github-e2e/ai-review.yml`
- Create: `fixtures/github-e2e/primary-ci.yml`
- Create: `fixtures/github-e2e/caller.yml`
- Create: `fixtures/github-e2e/AGENTS.md`
- Create: `fixtures/github-e2e/base/calculator.ts`
- Create: `fixtures/github-e2e/bad/calculator.ts`
- Create: `fixtures/github-e2e/good/calculator.ts`
- Create: `test/promotion/github-e2e-fixture.test.ts`
- External test repository create/use: `gushinets/ai-pr-review-fixture`

**Interfaces:**
- Consumes: Task 18 promoted full SHA, repository secret `QWEN_TOKEN_PLAN_API_KEY`, read-only Linear OAuth credentials, one deliberately created Linear fixture issue.
- Produces: real CI -> `workflow_run` -> Linear -> Rejudge/Pi/Token Plan -> artifact -> exact-head Check -> summary/inline -> new-head closure -> PASS evidence.

- [ ] **Step 1: Version the exact fixture repository files**

`primary-ci.yml` workflow name is exactly `Fixture CI`, runs only credential-free target validation under `pull_request`, and has `contents: read` only.

`ai-review.yml`:

```yaml
version: 1
primary_ci_workflow: Fixture CI
policy:
  always:
    - AGENTS.md
  scoped: []
```

`caller.yml` pins the frozen Task 18 `ENGINE_CANDIDATE_SHA` as one literal 40-hex `uses:` ref. It forwards only:

```text
QWEN_TOKEN_PLAN_API_KEY
LINEAR_CLIENT_ID
LINEAR_CLIENT_SECRET
```

There is no Alibaba workspace variable/input.

`fixtures/github-e2e/README.md` records the same central SHA and the successful promotion workflow run ID/URL, never secret values.

- [ ] **Step 2: Write fixture consistency tests**

Assert:

```text
caller uses one literal 40-hex central SHA
caller workflow_run name == Fixture CI
no alibaba_workspace_id / ALIBABA_WORKSPACE_ID
no legacy QWEN_API_KEY / BAILIAN_TOKEN_PLAN_API_KEY
no secrets: inherit
primary CI references no model/Linear secret
repo config parses as RepoConfigV1
bad fixture contains deterministic subtraction defect
good fixture fixes only that defect
```

- [ ] **Step 3: Define live operator inputs**

Required external setup:

```text
E2E_LINEAR_ISSUE = ANY-N fixture issue requiring correct subtraction
repository secret QWEN_TOKEN_PLAN_API_KEY
repository secret LINEAR_CLIENT_ID
repository secret LINEAR_CLIENT_SECRET
```

Do not grant Linear write scope to automate issue creation. Create/reuse one dedicated non-production Linear fixture issue through the normal UI.

- [ ] **Step 4: Create/update `gushinets/ai-pr-review-fixture` from the versioned fixture**

Copy the exact versioned files. Configure the three repository secrets above. Do **not** configure `ALIBABA_WORKSPACE_ID`.

Open the internal test PR with exact title/body metadata using the validated `E2E_LINEAR_ISSUE`; do not hard-code a production task.

- [ ] **Step 5: Verify bad-head lifecycle**

Require:

```text
Fixture CI completes
AI caller triggers from workflow_run
central called workflow SHA == frozen ENGINE_CANDIDATE_SHA
canonical ai-review-state-v1 artifact validates
AI PR Review Check is on exact bad head SHA
outcome BLOCK
stable summary exists exactly once
at least one actionable blocker identifies subtraction defect, inline when anchor valid
artifact/comments contain no raw Linear text or credential canary
```

- [ ] **Step 6: Push the good fix and verify current-run closure**

Change only subtraction to `a - b`. Require:

```text
new primary CI run
fresh review initial context does not include old blocker
closure resumes the CURRENT new-head run
old blocker resolved|invalidated
final PASS
stable summary updated rather than duplicated
old inline thread not auto-resolved
new Check attached to exact new head SHA
```

- [ ] **Step 7: Verify one Linear-driven UNABLE scenario with zero model call**

Use valid PR metadata referencing an inaccessible/nonexistent fixture Linear issue. Require:

```text
Linear load fails before Rejudge execution
canonical outcome UNABLE_TO_REVIEW
exact-head AI PR Review failure Check
sanitized unable reason only
no Token Plan call for that attempt
```

- [ ] **Step 8: Commit central fixture definition**

```bash
npm test -- test/promotion/github-e2e-fixture.test.ts
npm run check
git status --short
git add fixtures/github-e2e test/promotion/github-e2e-fixture.test.ts
git commit -m "test: define github ai review e2e fixture"
```

Do not advance to Tasks 20-21 unless the real E2E evidence passes using the frozen Task 18 engine SHA.

---

### Task 20: Integrate Stage 1 into `gushinets/anytoolai-platform`

**Files:**
- In `gushinets/anytoolai-platform`, create: `.github/ai-review.yml`
- In `gushinets/anytoolai-platform`, create: `.github/workflows/ai-pr-review.yml`

**Interfaces:**
- Consumes: one promotion-smoked + E2E-proven full central SHA; repository secrets `QWEN_TOKEN_PLAN_API_KEY`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`.
- Produces: informational `AI PR Review` after `baseline-backend`, without modifying current required-check rules.

- [ ] **Step 1: Add the exact base-SHA repo config**

```yaml
version: 1
primary_ci_workflow: baseline-backend
policy:
  always:
    - AGENTS.md
    - docs/agent/coding-conventions.md
    - docs/agent/review-checklist.md
  scoped: []
```

Validate every referenced policy file exists on `main` before merge.

- [ ] **Step 2: Add the thin caller pinned to the proven engine SHA**

Use `workflow_run` for `[baseline-backend]` completed plus manual `workflow_dispatch` with `pr_number`. Keep one caller job with concurrency/cancel behavior from the existing design.

The job must use:

```text
gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml@<literal frozen 40-hex SHA>
```

Inputs are only the central workflow's `mode`, `triggering_run_id`, and `pr_number`. Do not pass `engine_sha`, `alibaba_workspace_id`, provider URL, region, or model list.

Forward exactly:

```yaml
secrets:
  QWEN_TOKEN_PLAN_API_KEY: ${{ secrets.QWEN_TOKEN_PLAN_API_KEY }}
  LINEAR_CLIENT_ID: ${{ secrets.LINEAR_CLIENT_ID }}
  LINEAR_CLIENT_SECRET: ${{ secrets.LINEAR_CLIENT_SECRET }}
```

Never use `secrets: inherit`.

- [ ] **Step 3: Confirm existing primary CI remains unprivileged**

Inspect the current Platform primary workflow. Do not add Token Plan/Linear secrets or GitHub write capability to the target-code CI job.

- [ ] **Step 4: Configure repository secrets outside git**

Set only:

```text
QWEN_TOKEN_PLAN_API_KEY
LINEAR_CLIENT_ID
LINEAR_CLIENT_SECRET
```

There is no `ALIBABA_WORKSPACE_ID` variable and no PAT.

- [ ] **Step 5: Open the integration PR and verify Stage 1**

The integration PR includes repo config + caller together. After merge, use an internal-author test PR and verify informational `AI PR Review` appears after `baseline-backend` and is attached to the exact PR head.

Existing CI + human approval remain required; AI is not yet required.

- [ ] **Step 6: Verify and commit**

Run the repository's normal workflow/YAML validation, inspect the diff, then:

```bash
git add .github/ai-review.yml .github/workflows/ai-pr-review.yml
git commit -m "ci: add informational ai pr review"
```

Record the integration PR URL/SHA and observed test-run reference for Task 22.

---

### Task 21: Integrate Stage 1 into `gushinets/payments-portal`

**Files:**
- In `gushinets/payments-portal`, create: `.github/ai-review.yml`
- In `gushinets/payments-portal`, create: `.github/workflows/ai-pr-review.yml`

**Interfaces:**
- Consumes: the same promotion-smoked + E2E-proven central SHA and the same three repository secrets.
- Produces: informational `AI PR Review` after `CI`, with API/web scoped trusted base policy selection.

- [ ] **Step 1: Add Payments repo config**

```yaml
version: 1
primary_ci_workflow: CI
policy:
  always:
    - AGENTS.md
    - docs/engineering/CODING_CONVENTIONS.md
  scoped:
    - paths:
        - apps/api/**
      include:
        - apps/api/AGENTS.md
    - paths:
        - apps/web/**
      include:
        - apps/web/AGENTS.md
```

Validate every referenced file exists on `main`.

- [ ] **Step 2: Add the thin caller with the same literal proven engine SHA**

Use `workflow_run` for `[CI]` completed plus manual `workflow_dispatch` with `pr_number`. The reusable `uses:` ref contains the same literal 40-hex SHA proven by Tasks 18-19.

Inputs are only `mode`, `triggering_run_id`, and `pr_number`; no duplicate `engine_sha`, no workspace/provider inputs.

Forward exactly:

```text
QWEN_TOKEN_PLAN_API_KEY
LINEAR_CLIENT_ID
LINEAR_CLIENT_SECRET
```

and never `secrets: inherit`.

- [ ] **Step 3: Confirm current CI and metadata gates stay independent**

Do not merge AI review into the existing `CI` workflow. Existing deterministic Linear metadata validation remains its own gate. Existing target-code CI receives no model/Linear secret.

- [ ] **Step 4: Configure repository secrets outside git**

Set only the same three secret names. No workspace variable and no PAT.

- [ ] **Step 5: Verify Stage 1 and scoped policy behavior**

After merge, use an internal-author PR touching `apps/api/**` and confirm the base version of `apps/api/AGENTS.md` is selected. Repeat via a real run or deterministic policy test for `apps/web/**`. Confirm `AI PR Review` is informational and the existing required checks/human approval remain unchanged.

- [ ] **Step 6: Verify and commit**

Run the repository's normal workflow/YAML validation, inspect the diff, then:

```bash
git add .github/ai-review.yml .github/workflows/ai-pr-review.yml
git commit -m "ci: add informational ai pr review"
```

Record the integration PR URL/SHA and observed test-run reference for Task 22.

---

### Task 22: Run the Stage-1 Acceptance Gate and Prepare the Calibration Baseline

**Files:**
- Central modify: `docs/operations.md`
- Modify: `docs/calibration.md`
- Create: `docs/stage1-acceptance.md`

**Interfaces:**
- Consumes: final central code, Task 18 promotion evidence, Task 19 E2E evidence, both consumer Stage-1 integrations.
- Produces: auditable Stage-1 acceptance record. It does not enable Stage 2 or change repository rulesets.

- [ ] **Step 1: Run deterministic central verification on the final central branch state**

```bash
npm ci
npm run check
npm run test:security
npm run build
```

Require all green, including Rejudge 0.4.1 compatibility, Token Plan catalog/config, root-confinement, state compatibility, workflow permission/secret tests, and promotion fixture contract tests.

- [ ] **Step 2: Verify the exact consumer-pinned engine SHA has valid promotion evidence**

Require the literal SHA pinned in both consumer callers to be exactly the frozen Task 18 candidate and to have a successful promotion run proving:

```text
good PASS
bad BLOCK
same-run repair
historical closure
Token Plan runtime/provider assertions
security suite
```

If consumer SHAs differ, Stage 1 acceptance fails until they are aligned or each distinct SHA independently passes promotion + E2E.

- [ ] **Step 3: Verify GitHub E2E evidence**

Record fixture PR/run references proving:

```text
bad head -> BLOCK exact-head Check + canonical artifact + stable summary + actionable finding
good head -> fresh review + current-run closure -> PASS
Linear unavailable case -> exact-head UNABLE without a Token Plan call
```

Do not include secrets, raw Linear text, CI log bodies, model transcripts, or prompts in the acceptance document.

- [ ] **Step 4: Confirm real-run security invariants**

Verify and record zero known occurrences of:

```text
unauthorized Token Plan invocation
reviewer filesystem escape
secret leak
raw private Linear publication
raw failed CI log publication
wrong/stale-head machine verdict
PR-controlled code execution in privileged review path
publisher access to Token Plan/Linear secrets
PAYG/Coding Plan fallback
```

Any violation blocks Stage 1 acceptance until fixed and re-tested.

- [ ] **Step 5: Record Token Plan operational baseline**

From sanitized canonical data and provider console/operator evidence record:

```text
review latency samples
overall UNABLE rate so far
provider failure breakdown so far
input/output token totals when available
observed parallel 3-reviewer viability
Token Plan Credits checked externally in Alibaba subscription usage, not inferred locally
```

Do not invent per-review Credit or dollar spend.

- [ ] **Step 6: Create `docs/stage1-acceptance.md`**

Include:

```text
final central implementation SHA
frozen promoted engine SHA consumed by repositories
final Rejudge version
final exact Pi versions
promotion workflow run reference
GitHub E2E fixture PR/run references
Platform integration PR/SHA/test-run reference
Payments integration PR/SHA/test-run reference
security invariant checklist
Token Plan operational baseline
rollout state = Stage 1 informational
Stage 2 criteria copied/referenced from docs/calibration.md
```

No Stage-2 approval or ruleset change belongs here.

- [ ] **Step 7: Verify and commit**

```bash
npm run check
git status --short
git add docs/operations.md docs/calibration.md docs/stage1-acceptance.md
git commit -m "docs: record stage one ai review acceptance"
```

---

## Execution Order and Review Gates

The completed Tasks 1-16 are baseline only. Execute the remaining work in this order:

```text
Task 16A Token Plan/Rejudge migration
        |
        v
Task 17 Calibration
        |
        v
Task 18 Real Token Plan promotion
        |
        | freeze ENGINE_CANDIDATE_SHA
        v
Task 19 GitHub E2E using that exact SHA
        |
        +-------------------+
        v                   v
Task 20 Platform       Task 21 Payments
        +---------+---------+
                  v
          Task 22 Acceptance
```

Tasks 20 and 21 are independent after Task 19 and may be executed in parallel in isolated repositories/worktrees. All other remaining tasks are sequential because they produce the runtime/evidence consumed by the next task.

Each task is a separate commit/review gate. Do not squash task-boundary commits during development. Before reporting a task complete, verify the relevant tests/checks and working tree. A completion report must include task number/name, implemented slice, tests/checks, commit SHA, and any plan deviation/risk.

Do not opportunistically implement Stage 2 ruleset changes, a GitHub App, a database, a cross-repository Token Plan semaphore/queue, additional models, attachment ingestion, shell-enabled reviewers, automatic review-thread resolution, or human-approval replacement. Those remain outside V1.
