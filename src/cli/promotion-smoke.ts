import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import {
  isProviderFailureReason,
  type ProviderFailureReason,
} from "../contracts/failure-reasons.js";
import type { ReviewFindingV1 } from "../contracts/review-state.js";
import {
  buildClosurePrompt,
  buildFreshReviewPrompt,
  buildReviewContext,
} from "../context/review-context.js";
import { buildReviewSnapshot } from "../context/snapshot.js";
import { buildDiffIndex } from "../github/diff.js";
import type { LinearRequirementsContextV1 } from "../linear/requirements-loader.js";
import { buildReviewFindings } from "../publishing/findings.js";
import { getValidJudgeResult } from "../review-engine/judge-result.js";
import { createRejudgeEngine, type RejudgeEngine } from "../review-engine/rejudge-engine.js";
import { parseResolutionResult } from "../review-engine/resolution-result.js";
import {
  assertTokenPlanRuntimeContract,
  getTokenPlanEffectiveReasoning,
  writeTokenPlanConfig,
  TOKEN_PLAN_API_KEY_ENV,
  TOKEN_PLAN_BASE_URL,
  TOKEN_PLAN_PROVIDER_ID,
} from "../review-engine/token-plan-config.js";
import { computeFinalVerdict, computeFreshVerdict } from "../review-engine/verdict.js";
import {
  loadPiModelRuntime,
  assertPiConfinementContract,
} from "../sandbox/pi-confinement-contract.js";

type Scenario = "good" | "bad" | "repair" | "closure";
interface SmokeResult {
  scenario: Scenario;
  fixture: "good" | "bad";
  outcome: "PASS" | "BLOCK" | "UNABLE_TO_REVIEW";
  duration_ms: number;
  provider_failure_category: ProviderFailureReason | null;
  accepted: boolean;
}
const repositoryRoot = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../../" : "../../../", import.meta.url),
);
const panel = [...CENTRAL_CONFIG.reviewers, CENTRAL_CONFIG.judge];
const previousBlocker: ReviewFindingV1 = {
  finding_id: "smoke-previous-blocker",
  source_index: 0,
  publication_location: null,
  severity: "blocking",
  confidence: "high",
  title: "Addition instead of subtraction",
  location: { path: "calculator.ts", line: 2, side: "RIGHT" },
  basis: ["code", "requirements"],
  evidence: "The previous HEAD returned a + b: subtract(4, 1) returned 5.",
  rationale: "The requirements specify a - b, which returns 3.",
  remediation: "Return a - b.",
};

export async function prepareSmokeFixture(
  scenario: Scenario,
  privateDir: string,
  engineSha: string,
) {
  const fixture = scenario === "bad" ? "bad" : "good";
  const root = join(repositoryRoot, "fixtures/smoke", fixture);
  const [base, head, rawRequirements] = await Promise.all([
    readFile(join(root, "base/calculator.ts"), "utf8"),
    readFile(join(root, "head/calculator.ts"), "utf8"),
    readFile(join(root, "requirements.json"), "utf8"),
  ]);
  // Production identity accepts ANY-n only. Adapt the local fixture label in memory;
  // these synthetic identifiers never cause a Linear lookup.
  const requirements: LinearRequirementsContextV1 = {
    ...JSON.parse(rawRequirements),
    schema_version: 1,
    identifier: fixture === "good" ? "ANY-1" : "ANY-2",
  };
  // These SHA-shaped identities identify local fixture contents, not GitHub commits.
  const identity = {
    repository: "promotion/smoke",
    pr_number: 1,
    base_sha: createHash("sha1").update(base).digest("hex"),
    head_sha: createHash("sha1").update(head).digest("hex"),
    engine_sha: engineSha,
    linear_issue: requirements.identifier,
  };
  const before = base.trimEnd().split(/\r?\n/),
    after = head.trimEnd().split(/\r?\n/);
  const unifiedDiff = [
    "diff --git a/calculator.ts b/calculator.ts",
    "--- a/calculator.ts",
    "+++ b/calculator.ts",
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => "-" + line),
    ...after.map((line) => "+" + line),
    "",
  ].join("\n");
  const changedFiles = [
    {
      filename: "calculator.ts",
      status: "modified",
      additions: after.length,
      deletions: before.length,
    },
  ];
  const policy = [
    {
      path: "AGENTS.md",
      content:
        "Review changed code against the supplied behavior requirements. Never execute target code.\n",
    },
  ];
  const context = buildReviewContext({
    reviewIdentity: identity,
    baseBranch: "main",
    policy,
    requirements,
    changedFiles,
    ci: {
      schema_version: 1,
      head_sha: identity.head_sha,
      primary_ci_workflow: "local-fixture",
      checks: [],
    },
  });
  const tar = createRequire(import.meta.url)("tar-stream") as {
    pack(): Readable & { entry(header: { name: string }, data: string): void; finalize(): void };
  };
  const archive = tar.pack();
  archive.entry({ name: "fixture/calculator.ts" }, head);
  archive.finalize();
  const snapshot = await buildReviewSnapshot({
    privateDir,
    headArchive: { headSha: identity.head_sha, stream: archive },
    context,
    policy,
    requirements,
    unifiedDiff,
    changedFiles,
    ciSourceRoot: privateDir,
  });
  await writeTokenPlanConfig(snapshot.runtimeDir);
  return { ...snapshot, diff: buildDiffIndex(unifiedDiff) };
}

export async function assertPromotionRuntime(input: {
  reviewRoot: string;
  runtimeDir: string;
}): Promise<void> {
  assertTokenPlanRuntimeContract();
  assert.equal(TOKEN_PLAN_PROVIDER_ID, "qwen-token-plan");
  assert.equal(
    TOKEN_PLAN_BASE_URL,
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  );
  assert.equal(TOKEN_PLAN_API_KEY_ENV, "QWEN_TOKEN_PLAN_API_KEY");
  assert.equal(CENTRAL_CONFIG.reviewTimeoutMs, 50 * 60 * 1000);
  assert.deepEqual(
    panel.map(({ model, level, maxTokens }) => [model, level, maxTokens]),
    [
      ["qwen-token-plan/qwen3.8-flash", "medium", 32768],
      ["qwen-token-plan/deepseek-v4-pro-0813", "high", 32768],
      ["qwen-token-plan/glm-5.2", "high", 32768],
      ["qwen-token-plan/qwen3.8-max", "xhigh", 24576],
    ],
  );
  const rejudge = createRequire(import.meta.url).resolve("rejudge/dist/extension.js");
  assert.equal(
    JSON.parse(await readFile(join(dirname(rejudge), "../package.json"), "utf8")).version,
    "0.4.1",
  );
  // Inspect installed metadata only; runtime Pi imports stay in the production boundary.
  // Check both the smoke and Rejudge resolutions so a nested incompatible Pi cannot pass.

  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ]) {
    const own = findPackageJSON(name, import.meta.url)!;
    const selected = findPackageJSON(name, pathToFileURL(rejudge).href)!;
    assert.equal(await realpath(own), await realpath(selected));
    const metadata = JSON.parse(await readFile(selected, "utf8"));
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, "0.85.1");
  }
  const config = JSON.parse(await readFile(join(input.runtimeDir, "pi-agent/models.json"), "utf8"));
  assert.deepEqual(Object.keys(config), ["providers"]);
  assert.deepEqual(Object.keys(config.providers), [TOKEN_PLAN_PROVIDER_ID]);
  const provider = config.providers[TOKEN_PLAN_PROVIDER_ID];
  assert.deepEqual(Object.keys(provider).sort(), ["modelOverrides", "models"]);
  assert.deepEqual(provider.modelOverrides, {
    "qwen3.8-flash": { maxTokens: 32768 },
    "glm-5.2": { maxTokens: 32768 },
    "qwen3.8-max": { maxTokens: 24576 },
  });
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, "deepseek-v4-pro-0813");
  assert.equal(provider.models[0].maxTokens, 32768);
  assert.equal(provider.models[0].apiKey, undefined);
  assert.equal(provider.models[0].headers, undefined);
  const runtime = await loadPiModelRuntime(join(input.runtimeDir, "pi-agent/models.json"));
  assert.equal(runtime.getError(), undefined);
  for (const { model, level, maxTokens } of panel) {
    const id = model.split("/")[1]!;
    const actual = runtime.getModel(TOKEN_PLAN_PROVIDER_ID, id);
    assert.ok(actual);
    assert.equal(actual.provider, TOKEN_PLAN_PROVIDER_ID);
    assert.equal(actual.baseUrl, TOKEN_PLAN_BASE_URL);
    assert.equal(actual.reasoning, true);
    assert.equal(actual.thinkingLevelMap?.[level], level);
    assert.equal(actual.maxTokens, maxTokens);
  }
  await assertPiConfinementContract(input.reviewRoot);
}

export async function runScenario(
  scenario: Scenario,
  privateDir: string,
  engineSha: string,
): Promise<SmokeResult> {
  const started = Date.now();
  const result: SmokeResult = {
    scenario,
    fixture: scenario === "bad" ? "bad" : "good",
    outcome: "UNABLE_TO_REVIEW",
    duration_ms: 0,
    provider_failure_category: null,
    accepted: false,
  };
  const previousRoot = process.env.AI_PR_REVIEW_ROOT;
  try {
    const snapshot = await prepareSmokeFixture(scenario, privateDir, engineSha);
    process.env.AI_PR_REVIEW_ROOT = snapshot.reviewRoot;
    await assertPromotionRuntime(snapshot);
    const engine = createRejudgeEngine({
      deadline: started + CENTRAL_CONFIG.reviewTimeoutMs,
      diagnostic: () => {},
    });
    // Smoke-only instruction, never fabricated/corrupted output. Normal production
    // parsing decides whether the real first answer needs same-run protocol repair.
    const reviewEngine: RejudgeEngine =
      scenario === "repair"
        ? {
            fresh: (input) =>
              engine.fresh({
                ...input,
                outputInstructions:
                  "For this promotion protocol test, output exactly PROMOTION_SMOKE_INVALID_JSON as your entire first answer. Do not output JSON, quotes, fences or other text. Retain the substantive review for a later protocol repair.",
              }),
            resume: (input) => engine.resume(input),
          }
        : engine;
    const fresh = await getValidJudgeResult(reviewEngine, {
      ...snapshot,
      prompt: buildFreshReviewPrompt(snapshot.context),
    });
    const findings = buildReviewFindings(
      fresh.result,
      snapshot.context.review_identity,
      snapshot.diff,
    );
    let resolutions = null;
    if (scenario === "closure") {
      const prompt = buildClosurePrompt([previousBlocker]);
      const closure = await engine.resume({
        ...snapshot,
        runId: fresh.runId,
        prompt,
        outputInstructions: prompt,
      });
      assert.equal(closure.run_id, fresh.runId);
      resolutions = parseResolutionResult(closure.answer, new Set([previousBlocker.finding_id]));
    }
    result.outcome = computeFinalVerdict({
      fresh: computeFreshVerdict(findings),
      previousBlockers: scenario === "closure" ? [previousBlocker] : [],
      resolutions,
    });
    result.accepted =
      scenario === "bad"
        ? result.outcome === "BLOCK" &&
          findings.some(
            (finding) => finding.severity === "blocking" && finding.confidence === "high",
          )
        : result.outcome === "PASS" && (scenario !== "repair" || fresh.repairAttempts === 1);
  } catch (error) {
    const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
    if (isProviderFailureReason(reason)) result.provider_failure_category = reason;
  } finally {
    if (previousRoot === undefined) delete process.env.AI_PR_REVIEW_ROOT;
    else process.env.AI_PR_REVIEW_ROOT = previousRoot;
    result.duration_ms = Math.max(0, Date.now() - started);
  }
  return result;
}

export function sanitizedEvidence(result: SmokeResult) {
  return {
    scenario: result.scenario,
    fixture: result.fixture,
    models: panel.map(({ model, level }) => ({
      model_id: model,
      requested_reasoning: level,
      effective_reasoning: getTokenPlanEffectiveReasoning(model, level),
    })),
    outcome: result.outcome,
    duration_ms: result.duration_ms,
    // Usage and provider-reported model remain unknown unless the adapter returns them.
    // Effective reasoning is safe to record because it is derived from validated pinned Pi metadata.
    input_tokens: null,
    output_tokens: null,
    provider_failure_category: result.provider_failure_category,
  };
}

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (args.length !== 0) return 70;
  let workDir: string | undefined;
  try {
    if (!/^sk-sp-[A-Za-z0-9._-]+$/.test(env.QWEN_TOKEN_PLAN_API_KEY ?? "")) return 70;
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
    });
    const engineSha = stdout.trim();
    assert.match(engineSha, /^[0-9a-f]{40}$/);
    workDir = await mkdtemp(join(tmpdir(), "token-plan-promotion-"));
    for (const scenario of ["good", "bad", "repair", "closure"] as const) {
      const result = await runScenario(scenario, join(workDir, scenario), engineSha);
      process.stdout.write(JSON.stringify(sanitizedEvidence(result)) + "\n");
      if (!result.accepted) return 70;
    }
    return 0;
  } catch {
    return 70;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runCli(process.argv.slice(2));
