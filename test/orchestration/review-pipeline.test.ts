import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareReview,
  executeReview,
  runReviewPipeline,
} from "../../src/orchestration/review-pipeline.js";
import type { GithubReadClient } from "../../src/github/github-client.js";
import type { PreflightResult } from "../../src/orchestration/preflight-pipeline.js";
import type { JudgeResultV1 } from "../../src/contracts/judge-result.js";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import type { StateDiscovery } from "../../src/state/github-artifact-store.js";
import { buildReviewState, parseReviewState } from "../../src/state/review-state.js";
import { type RejudgeEngine, RejudgeEngineError } from "../../src/review-engine/rejudge-engine.js";
import { UNABLE_REASONS } from "../../src/contracts/failure-reasons.js";

const head = "a".repeat(40),
  base = "b".repeat(40),
  engineSha = "c".repeat(40);
const runId = "2026-09-11T01-02-03-004Z-abc123";
const pass: JudgeResultV1 = { schema_version: 1, summary: "Review completed", findings: [] };
const block: JudgeResultV1 = {
  ...pass,
  findings: [
    {
      severity: "blocking",
      confidence: "high",
      title: "Missing validation",
      location: { path: "run.sh", line: 1, side: "RIGHT" },
      basis: ["code"],
      evidence: "Input reaches the operation unchecked",
      rationale: "An invalid input corrupts stored records",
      remediation: "Reject invalid input before writing",
    },
  ],
};
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const workDir = await mkdtemp(join(tmpdir(), "review-pipeline-"));
  temps.push(workDir);
  const identity = {
    repository: "o/r",
    pr_number: 1,
    base_sha: base,
    head_sha: head,
    engine_sha: engineSha,
    linear_issue: "ANY-1",
  };
  const { linear_issue: _, ...attempt } = identity;
  const preflight: PreflightResult = {
    schema_version: 1,
    mode: "manual",
    status: "READY",
    unable_reason: null,
    repository: "o/r",
    pr_number: 1,
    base_branch: "main",
    base_sha: base,
    head_sha: head,
    linear_issue: "ANY-1",
    review_attempt_identity: attempt,
    review_identity: identity,
    changed_files: [],
  };
  const calls: string[] = [];
  const github = {
    getPullRequest: async () => {
      calls.push("head");
      return {
        number: 1,
        repository: "o/r",
        state: "open",
        baseBranch: "main",
        baseSha: base,
        headSha: head,
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        title: "ANY-1 - Change",
        body: "",
        author: "owner",
      };
    },
    readContent: async (_r: string, path: string, sha: string) => {
      calls.push(path);
      expect(sha).toBe(base);
      return path === ".github/ai-review.yml"
        ? "version: 1\nprimary_ci_workflow: CI\npolicy:\n  always: [AGENTS.md]\n  scoped: []\n"
        : "Validate inputs";
    },
    listChangedFiles: async () => [],
    getPullRequestDiff: async () => "",
    listCheckRuns: async (_r: string, sha: string) => {
      calls.push("ci");
      expect(sha).toBe(head);
      return [];
    },
    getCommitStatuses: async () => ({ sha: head, statuses: [] }),
    listWorkflowRuns: async () => [],
    downloadHeadArchive: async (_r: string, sha: string) => {
      calls.push("archive");
      expect(sha).toBe(head);
      return createReadStream(
        new URL("../../fixtures/security/archive-inert.tar", import.meta.url),
      );
    },
  } as unknown as GithubReadClient;
  const loadState = vi.fn(async (): Promise<StateDiscovery> => {
    calls.push("state");
    return { kind: "fresh", previous: null, history: [], rerunnable: null };
  });
  const loadRequirements = vi.fn(async () => {
    calls.push("linear");
    return {
      schema_version: 1 as const,
      identifier: "ANY-1",
      title: "Private task title",
      description: "Private description with secret-canary",
      comments: [],
    };
  });
  const engine = {
    fresh: vi.fn<RejudgeEngine["fresh"]>(async () => {
      calls.push("fresh");
      return { answer: JSON.stringify(pass), run_id: runId };
    }),
    resume: vi.fn<RejudgeEngine["resume"]>(async () => ({
      answer: JSON.stringify(pass),
      run_id: runId,
    })),
  };
  const prepare = { github, loadState, loadRequirements, secretValues: ["secret-canary"] };
  const execute = { github, engine, workspaceId: "workspace", secretValues: ["qwen-canary"] };
  return {
    workDir,
    preflight,
    calls,
    github,
    loadState,
    loadRequirements,
    engine,
    prepare,
    execute,
  };
}
function state(
  f: Awaited<ReturnType<typeof fixture>>,
  h = "d".repeat(40),
  judge = block,
): ReviewStateV1 {
  const identity = { ...f.preflight.review_identity!, head_sha: h };
  const { linear_issue: _, ...attempt } = identity;
  return buildReviewState(
    {
      attempt_identity: attempt,
      review_identity: identity,
      lineage: { base_branch: "main", linear_issue: "ANY-1" },
      outcome: judge.findings.length ? "BLOCK" : "PASS",
      unable_reason: null,
      ci_summary: { head_sha: h, primary_ci_workflow: "CI", checks: [] },
      judge_result: judge,
      resolution_result: null,
      previous_review_head_sha: null,
      telemetry: {
        started_at: "2026-09-11",
        finished_at: "2026-09-11",
        duration_ms: 1,
        models: [],
        judge_repair_attempts: 0,
        closure_used: false,
        rejudge_status: "completed",
        rejudge_failed_stage: null,
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null,
      },
    },
    { privateTexts: [], secretValues: [] },
    { contains: () => false },
  );
}
it.each([pass, block])(
  "runs actual loading/snapshot and computes deterministic outcome",
  async (judge) => {
    const f = await fixture();
    f.engine.fresh.mockResolvedValue({ answer: JSON.stringify(judge), run_id: runId });
    const result = await runReviewPipeline(
      { preflight: f.preflight, workDir: f.workDir },
      f.prepare,
      f.execute,
    );
    expect(result).toMatchObject({
      kind: "STATE_READY",
      state: {
        outcome: judge.findings.length ? "BLOCK" : "PASS",
        judge_result: {
          ...judge,
          summary:
            judge.summary +
            "\n\nNo compatible prior review was available; historical verification was not performed.",
        },
      },
    });
    expect(f.calls.indexOf("state")).toBeLessThan(f.calls.indexOf("linear"));
    expect(f.calls.indexOf("linear")).toBeLessThan(f.calls.indexOf("AGENTS.md"));
    expect(f.calls.at(-1)).toBe("head");
    expect(f.engine.fresh).toHaveBeenCalledTimes(1);
    expect(f.engine.resume).not.toHaveBeenCalled();
    const root = join(f.workDir, "private/review-root");
    expect(await readFile(join(root, "target/.pi/extensions/evil.js"), "utf8")).toBe(
      "UNTRUSTED_HEAD",
    );
    expect(await readFile(join(root, "requirements/linear.json"), "utf8")).not.toContain(
      "secret-canary",
    );
    expect(f.engine.fresh.mock.calls[0]?.[0]).toMatchObject({
      reviewRoot: root,
      runtimeDir: join(f.workDir, "private/runtime"),
    });
    expect(JSON.stringify(result)).not.toContain("Private task title");
  },
);
it.each([pass, block])("reuses same identity before Linear, snapshot and models", async (judge) => {
  const f = await fixture(),
    saved = state(f, head, judge);
  f.loadState.mockResolvedValue({ kind: "reuse", state: saved });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toEqual({ kind: "STATE_READY", state: saved });
  expect(f.calls).toEqual(["head"]);
  expect(f.loadState).toHaveBeenCalledTimes(1);
  expect(f.loadRequirements).not.toHaveBeenCalled();
  expect(f.engine.fresh).not.toHaveBeenCalled();
});
it("reruns UNABLE and never serializes prepare credentials across the process boundary", async () => {
  const f = await fixture();
  const failed = {
    ...state(f, head),
    outcome: "UNABLE_TO_REVIEW" as const,
    unable_reason: "INTERNAL_ERROR" as const,
    judge_result: null,
    findings: [],
  };
  f.loadState.mockResolvedValue({ kind: "fresh", previous: null, history: [], rerunnable: failed });
  const result = await prepareReview({ preflight: f.preflight, workDir: f.workDir }, f.prepare);
  expect(result.kind).toBe("PREPARED");
  const text = await readFile(join(f.workDir, "private/prepared-review-v1.json"), "utf8");
  expect(text).not.toContain("secret-canary");
  expect(text).not.toContain("secretValues");
  expect(text).toContain("Private task title");
  expect(f.engine.fresh).not.toHaveBeenCalled();
});
it("performs exactly one repair on the current run", async () => {
  const f = await fixture();
  f.engine.fresh.mockResolvedValue({ answer: "invalid", run_id: runId });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({ state: { outcome: "PASS", telemetry: { judge_repair_attempts: 1 } } });
  expect(f.engine.fresh).toHaveBeenCalledTimes(1);
  expect(f.engine.resume).toHaveBeenCalledTimes(1);
  expect(f.engine.resume.mock.calls[0]?.[0]).toMatchObject({ runId });
});
it("carries H1 blocker through H2 empty fresh findings into H3 closure", async () => {
  const f = await fixture(),
    h1 = state(f),
    h2 = state(f, "e".repeat(40), pass);
  const id = h1.findings[0]!.finding_id;
  h2.outcome = "BLOCK";
  h2.previous_review_head_sha = h1.attempt_identity.head_sha;
  h2.resolution_result = {
    schema_version: 1,
    resolutions: [
      {
        previous_finding_id: id,
        status: "still_present",
        confidence: "high",
        current_location: { path: "run.sh", line: 2, side: "RIGHT" },
        evidence: "The unchecked operation remains",
      },
    ],
  };
  f.loadState.mockResolvedValue({
    kind: "fresh",
    previous: h2,
    history: [h2, h1],
    rerunnable: null,
  });
  f.engine.resume.mockResolvedValue({
    run_id: runId,
    answer: JSON.stringify(h2.resolution_result),
  });
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result).toMatchObject({
    state: {
      outcome: "BLOCK",
      findings: [],
      previous_review_head_sha: h2.attempt_identity.head_sha,
      resolution_result: h2.resolution_result,
    },
  });
  expect(f.engine.fresh.mock.calls[0]?.[0]).not.toHaveProperty("previous");
  expect(f.engine.resume.mock.calls[0]?.[0]).toMatchObject({ runId });
  expect(JSON.stringify(f.engine.resume.mock.calls)).toContain(id);
  expect(f.engine.resume).toHaveBeenCalledTimes(1);
});
it.each(["resolved", "invalidated", "still_present", "uncertain"] as const)(
  "maps historical %s deterministically",
  async (status) => {
    const f = await fixture(),
      prior = state(f);
    f.loadState.mockResolvedValue({
      kind: "fresh",
      previous: prior,
      history: [prior],
      rerunnable: null,
    });
    f.engine.resume.mockResolvedValue({
      run_id: runId,
      answer: JSON.stringify({
        schema_version: 1,
        resolutions: [
          {
            previous_finding_id: prior.findings[0]!.finding_id,
            status,
            confidence: "high",
            current_location: null,
            evidence: "Current inspection evidence",
          },
        ],
      }),
    });
    const result = await runReviewPipeline(
      { preflight: f.preflight, workDir: f.workDir },
      f.prepare,
      f.execute,
    );
    expect(result).toMatchObject({
      state: {
        outcome:
          status === "still_present"
            ? "BLOCK"
            : status === "uncertain"
              ? "UNABLE_TO_REVIEW"
              : "PASS",
      },
    });
  },
);
it.each(
  UNABLE_REASONS.filter(
    (r) =>
      ![
        "SNAPSHOT_FAILED",
        "REJUDGE_PANEL_FAILED",
        "REJUDGE_JUDGE_FAILED",
        "JUDGE_RESULT_INVALID",
        "JUDGE_REPAIR_FAILED",
        "CLOSURE_FAILED",
        "CLOSURE_RESULT_INVALID",
      ].includes(r),
  ),
)("persists typed %s preflight failures only after a head barrier", async (reason) => {
  const f = await fixture();
  f.preflight.status = "UNABLE_TO_REVIEW";
  f.preflight.unable_reason = reason;
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result).toMatchObject({
    kind: "STATE_READY",
    state: { outcome: "UNABLE_TO_REVIEW", unable_reason: reason },
  });
  expect(f.engine.fresh).not.toHaveBeenCalled();
  expect(f.calls.at(-1)).toBe("head");
});
it.each([
  "REJUDGE_PANEL_FAILED",
  "REJUDGE_JUDGE_FAILED",
  "JUDGE_REPAIR_FAILED",
  "CLOSURE_FAILED",
  "CLOSURE_RESULT_INVALID",
  "INTERNAL_ERROR",
])("does not convert %s to PASS", async (reason) => {
  const f = await fixture();
  if (reason === "REJUDGE_PANEL_FAILED" || reason === "REJUDGE_JUDGE_FAILED")
    f.engine.fresh.mockRejectedValue(
      new RejudgeEngineError(reason === "REJUDGE_PANEL_FAILED" ? "panel" : "judge"),
    );
  else if (reason === "JUDGE_REPAIR_FAILED") {
    f.engine.fresh.mockResolvedValue({ answer: "invalid", run_id: runId });
    f.engine.resume.mockResolvedValue({ answer: "invalid again", run_id: runId });
  } else if (reason.startsWith("CLOSURE")) {
    const prior = state(f);
    f.loadState.mockResolvedValue({
      kind: "fresh",
      previous: prior,
      history: [prior],
      rerunnable: null,
    });
    if (reason === "CLOSURE_FAILED")
      f.engine.resume.mockRejectedValue(new Error("provider-body-canary"));
    else f.engine.resume.mockResolvedValue({ answer: "{}", run_id: runId });
  } else {
    f.execute.secretValues = ["run.sh"];
    f.engine.fresh.mockResolvedValue({ answer: JSON.stringify(block), run_id: runId });
  }
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result).toMatchObject({
    state: {
      outcome: "UNABLE_TO_REVIEW",
      unable_reason: reason,
      findings: [],
      resolution_result: null,
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/provider-body-canary|qwen-canary/);
  expect(f.calls.at(-1)).toBe("head");
  expect(f.engine.fresh).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  "suppresses success/failure when head moves after model (failure=%s)",
  async (fail) => {
    const f = await fixture();
    f.engine.fresh.mockImplementation(async () => {
      f.github.getPullRequest = async () => ({ headSha: "f".repeat(40) }) as never;
      if (fail) throw new RejudgeEngineError("panel");
      return { answer: JSON.stringify(pass), run_id: runId };
    });
    expect(
      await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
    ).toEqual({ kind: "STALE_SKIPPED" });
  },
);
it("fails state discovery closed before loading private inputs", async () => {
  const f = await fixture();
  f.loadState.mockRejectedValue(new Error("corrupt-private-body"));
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({ state: { outcome: "UNABLE_TO_REVIEW", unable_reason: "STATE_LOAD_FAILED" } });
  expect(f.loadRequirements).not.toHaveBeenCalled();
  expect(f.engine.fresh).not.toHaveBeenCalled();
});
it.each(["", "bad/workspace"])("rejects workspace %j before any model", async (workspaceId) => {
  const f = await fixture();
  await prepareReview({ preflight: f.preflight, workDir: f.workDir }, f.prepare);
  expect(
    await executeReview(
      { preflight: f.preflight, workDir: f.workDir },
      { ...f.execute, workspaceId },
    ),
  ).toMatchObject({ state: { outcome: "UNABLE_TO_REVIEW" } });
  expect(f.engine.fresh).not.toHaveBeenCalled();
});

it.each([
  "CONFIG_MISSING",
  "CONFIG_INVALID",
  "POLICY_MISSING",
  "LINEAR_AUTH_FAILED",
  "LINEAR_NOT_FOUND",
  "LINEAR_UNAVAILABLE",
  "LINEAR_CONTEXT_TOO_LARGE",
  "CI_CONTEXT_UNAVAILABLE",
  "SNAPSHOT_FAILED",
  "PR_TOO_LARGE",
] as const)("maps real pre-model %s failure without any model", async (reason) => {
  const f = await fixture();
  if (reason.startsWith("LINEAR")) f.loadRequirements.mockRejectedValue({ reason });
  else if (reason === "CONFIG_MISSING") f.github.readContent = async () => undefined;
  else if (reason === "CONFIG_INVALID") f.github.readContent = async () => "unknown: key";
  else if (reason === "POLICY_MISSING") {
    const read = f.github.readContent;
    f.github.readContent = async (r, p, sha) => (p === "AGENTS.md" ? undefined : read(r, p, sha));
  } else if (reason === "CI_CONTEXT_UNAVAILABLE")
    f.github.listCheckRuns = async () => {
      throw new Error("raw body");
    };
  else if (reason === "SNAPSHOT_FAILED")
    f.github.downloadHeadArchive = async () => {
      throw new Error("raw body");
    };
  else {
    const get = f.github.getPullRequest;
    f.github.getPullRequest = async (r, n) => ({ ...(await get(r, n)), changedFiles: 251 });
  }
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({ state: { outcome: "UNABLE_TO_REVIEW", unable_reason: reason } });
  expect(f.engine.fresh).not.toHaveBeenCalled();
  expect(f.calls.at(-1)).toBe("head");
});
it("maps typed judge protocol errors without inventing a PASS", async () => {
  const f = await fixture();
  f.engine.fresh.mockRejectedValue({ reason: "JUDGE_RESULT_INVALID" });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: { outcome: "UNABLE_TO_REVIEW", unable_reason: "JUDGE_RESULT_INVALID" },
  });
});
it("loads changed files after reuse lookup to select scoped policy in the production CLI path", async () => {
  const f = await fixture();
  f.github.listChangedFiles = async () => [
    { filename: "run.sh", status: "modified", additions: 1, deletions: 1 },
  ];
  f.github.getPullRequestDiff = async () =>
    "diff --git a/run.sh b/run.sh\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-old\n+new\n";
  const get = f.github.getPullRequest;
  f.github.getPullRequest = async (r, n) => ({
    ...(await get(r, n)),
    changedFiles: 1,
    additions: 1,
    deletions: 1,
  });
  f.github.readContent = async (_r, path) =>
    path === ".github/ai-review.yml"
      ? "version: 1\nprimary_ci_workflow: CI\npolicy:\n  always: []\n  scoped:\n    - paths: [run.sh]\n      include: [AGENTS.md]\n"
      : "Scoped trusted policy";
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({ state: { outcome: "PASS" } });
  expect(
    await readFile(join(f.workDir, "private/review-root/control/policy/AGENTS.md"), "utf8"),
  ).toBe("Scoped trusted policy");
});
it("redacts prepare credentials echoed in CI metadata before materializing reviewer context", async () => {
  const f = await fixture();
  f.github.listCheckRuns = async () => [
    {
      id: 1,
      name: "failed secret-canary",
      headSha: head,
      status: "completed",
      conclusion: "failure",
      detailsUrl: "https://example.com/secret-canary",
      externalId: null,
      appId: null,
    },
  ];
  expect(await prepareReview({ preflight: f.preflight, workDir: f.workDir }, f.prepare)).toEqual({
    kind: "PREPARED",
  });
  for (const path of [
    "private/prepared-review-v1.json",
    "private/review-root/metadata/review-context.json",
    "private/review-root/evidence/ci/status.json",
  ])
    expect(await readFile(join(f.workDir, path), "utf8")).not.toContain("secret-canary");
});
it("repairs once then closes only once on the same current run", async () => {
  const f = await fixture(),
    prior = state(f);
  f.loadState.mockResolvedValue({
    kind: "fresh",
    previous: prior,
    history: [prior],
    rerunnable: null,
  });
  f.engine.fresh.mockResolvedValue({ answer: "bad JSON", run_id: runId });
  const resolution = {
    schema_version: 1,
    resolutions: [
      {
        previous_finding_id: prior.findings[0]!.finding_id,
        status: "resolved",
        confidence: "high",
        current_location: null,
        evidence: "Guard now rejects invalid input",
      },
    ],
  };
  f.engine.resume
    .mockResolvedValueOnce({ answer: JSON.stringify(pass), run_id: runId })
    .mockResolvedValueOnce({ answer: JSON.stringify(resolution), run_id: runId });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: { outcome: "PASS", telemetry: { judge_repair_attempts: 1, closure_used: true } },
  });
  expect(f.engine.fresh).toHaveBeenCalledTimes(1);
  expect(f.engine.resume).toHaveBeenCalledTimes(2);
  for (const [input] of f.engine.resume.mock.calls)
    expect(input).toMatchObject({
      runId,
      reviewRoot: join(f.workDir, "private/review-root"),
      runtimeDir: join(f.workDir, "private/runtime"),
    });
});
it("does not let a fresh BLOCK hide required closure failure", async () => {
  const f = await fixture(),
    prior = state(f);
  f.loadState.mockResolvedValue({
    kind: "fresh",
    previous: prior,
    history: [prior],
    rerunnable: null,
  });
  f.engine.fresh.mockResolvedValue({ answer: JSON.stringify(block), run_id: runId });
  f.engine.resume.mockRejectedValue(new Error("technical failure"));
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: { outcome: "UNABLE_TO_REVIEW", unable_reason: "CLOSURE_FAILED", findings: [] },
  });
});
it("does not union more than 20 pending historical findings into the fresh findings cap", async () => {
  const f = await fixture();
  const many = {
    ...block,
    findings: Array.from({ length: 20 }, (_, i) => ({
      ...block.findings[0]!,
      title: `Unsafe operation ${i}`,
    })),
  };
  const h1 = state(f, "d".repeat(40), many),
    h2 = state(f, "e".repeat(40), block);
  h2.previous_review_head_sha = h1.attempt_identity.head_sha;
  h2.resolution_result = {
    schema_version: 1,
    resolutions: h1.findings.map((finding) => ({
      previous_finding_id: finding.finding_id,
      status: "still_present",
      confidence: "high",
      current_location: null,
      evidence: "Unchecked operation remains",
    })),
  };
  f.loadState.mockResolvedValue({
    kind: "fresh",
    previous: h2,
    history: [h2, h1],
    rerunnable: null,
  });
  f.engine.resume.mockResolvedValue({
    run_id: runId,
    answer: JSON.stringify({
      schema_version: 1,
      resolutions: [...h2.findings, ...h1.findings].map((finding) => ({
        previous_finding_id: finding.finding_id,
        status: "still_present",
        confidence: "high",
        current_location: null,
        evidence: "Unchecked operation remains",
      })),
    }),
  });
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result).toMatchObject({ state: { outcome: "BLOCK", findings: [] } });
  if (result.kind === "STATE_READY")
    expect(result.state.resolution_result?.resolutions).toHaveLength(21);
});

it.each(["extra-field", "wrong-identity", "wrong-history", "root-link"])(
  "rejects prepared boundary attack %s before any model",
  async (attack) => {
    const f = await fixture();
    await prepareReview({ preflight: f.preflight, workDir: f.workDir }, f.prepare);
    const path = join(f.workDir, "private/prepared-review-v1.json");
    const prepared = JSON.parse(await readFile(path, "utf8"));
    if (attack === "extra-field") prepared.secretValues = ["foreign-secret"];
    if (attack === "wrong-identity") prepared.context.review_identity.head_sha = "d".repeat(40);
    if (attack === "wrong-history")
      prepared.history = [
        { ...state(f), lineage: { base_branch: "foreign-branch", linear_issue: "ANY-1" } },
      ];
    if (attack === "root-link") {
      const root = join(f.workDir, "private/review-root");
      await rename(root, root + "-saved");
      await symlink(root + "-saved", root, process.platform === "win32" ? "junction" : "dir");
    } else await writeFile(path, JSON.stringify(prepared));
    expect(
      await executeReview({ preflight: f.preflight, workDir: f.workDir }, f.execute),
    ).toMatchObject({ state: { outcome: "UNABLE_TO_REVIEW", unable_reason: "INTERNAL_ERROR" } });
    expect(f.engine.fresh).not.toHaveBeenCalled();
  },
);
it("sanitizes quoted private Linear and failed-log evidence before assigning finding IDs", async () => {
  const f = await fixture();
  f.github.listCheckRuns = async () => [
    {
      id: 8,
      name: "tests",
      headSha: head,
      status: "completed",
      conclusion: "failure",
      detailsUrl: null,
      externalId: null,
      appId: null,
    },
  ];
  f.github.listWorkflowRuns = async () => [{ id: 4, headSha: head }];
  f.github.listWorkflowJobs = async () => [
    {
      id: 5,
      runId: 4,
      headSha: head,
      checkRunUrl: "https://api.github.com/repos/o/r/check-runs/8",
    },
  ];
  f.github.downloadJobLog = async () => "Private CI log evidence secret-canary";
  f.engine.fresh.mockResolvedValue({
    answer: JSON.stringify({
      ...block,
      summary: "Private task title",
      findings: [{ ...block.findings[0], evidence: "Private CI log evidence [REDACTED]" }],
    }),
    run_id: runId,
  });
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result).toMatchObject({
    state: {
      outcome: "BLOCK",
      judge_result: {
        summary:
          "[REDACTED PRIVATE SOURCE]\n\nNo compatible prior review was available; historical verification was not performed.",
      },
      findings: [{ evidence: "[REDACTED PRIVATE SOURCE]" }],
    },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /Private task title|Private CI log evidence|secret-canary/,
  );
});
it("reports optional log unavailability and still reviews the exact known failing check", async () => {
  const f = await fixture(),
    warn = vi.fn();
  f.github.listCheckRuns = async () => [
    {
      id: 8,
      name: "tests",
      headSha: head,
      status: "completed",
      conclusion: "failure",
      detailsUrl: null,
      externalId: null,
      appId: null,
    },
  ];
  f.github.listWorkflowRuns = async () => {
    throw new Error("private provider body");
  };
  expect(
    await runReviewPipeline(
      { preflight: f.preflight, workDir: f.workDir },
      { ...f.prepare, warn },
      f.execute,
    ),
  ).toMatchObject({
    state: { outcome: "PASS", ci_summary: { checks: [{ name: "tests", conclusion: "failure" }] } },
  });
  expect(warn.mock.calls).toEqual([["CI_JOB_MAPPING_UNAVAILABLE"]]);
  expect(f.engine.fresh.mock.calls[0]![0].prompt).toContain('"conclusion":"failure"');
});
it("never replaces an unsafe immutable base branch with an invented safe lineage", async () => {
  const f = await fixture();
  f.preflight.base_branch = "secret-canary";
  f.loadState.mockRejectedValue(new Error("failed"));
  await expect(
    prepareReview({ preflight: f.preflight, workDir: f.workDir }, f.prepare),
  ).rejects.toThrow();
  expect(f.engine.fresh).not.toHaveBeenCalled();
});
it("repairs an unknown snapshot path once before computing a verdict", async () => {
  const f = await fixture();
  f.engine.fresh.mockResolvedValue({
    answer: JSON.stringify({
      ...block,
      findings: [
        { ...block.findings[0], location: { path: "missing.ts", line: 1, side: "RIGHT" } },
      ],
    }),
    run_id: runId,
  });
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result).toMatchObject({
    state: { outcome: "PASS", telemetry: { judge_repair_attempts: 1 } },
  });
  expect(f.engine.resume).toHaveBeenCalledTimes(1);
});
it("rejects a repair which still names a path absent from reviewed evidence", async () => {
  const f = await fixture(),
    answer = JSON.stringify({
      ...block,
      findings: [
        { ...block.findings[0], location: { path: "missing.ts", line: 1, side: "RIGHT" } },
      ],
    });
  f.engine.fresh.mockResolvedValue({ answer, run_id: runId });
  f.engine.resume.mockResolvedValue({ answer, run_id: runId });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: {
      outcome: "UNABLE_TO_REVIEW",
      unable_reason: "JUDGE_REPAIR_FAILED",
      telemetry: { judge_repair_attempts: 1 },
    },
  });
  expect(f.engine.resume).toHaveBeenCalledTimes(1);
});
it("keeps a snapshot file outside the diff as summary-only evidence", async () => {
  const f = await fixture();
  f.engine.fresh.mockResolvedValue({ answer: JSON.stringify(block), run_id: runId });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: {
      outcome: "BLOCK",
      findings: [
        { location: { path: "run.sh", line: 1, side: "RIGHT" }, publication_location: null },
      ],
    },
  });
  expect(f.engine.resume).not.toHaveBeenCalled();
});
it("accepts deleted LEFT evidence represented by the trusted parsed diff", async () => {
  const f = await fixture();
  f.github.listChangedFiles = async () => [
    { filename: "deleted.ts", status: "removed", additions: 0, deletions: 1 },
  ];
  f.github.getPullRequestDiff = async () =>
    "diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
  const get = f.github.getPullRequest;
  f.github.getPullRequest = async (r, n) => ({
    ...(await get(r, n)),
    changedFiles: 1,
    additions: 0,
    deletions: 1,
  });
  f.engine.fresh.mockResolvedValue({
    answer: JSON.stringify({
      ...block,
      findings: [{ ...block.findings[0], location: { path: "deleted.ts", line: 1, side: "LEFT" } }],
    }),
    run_id: runId,
  });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: {
      outcome: "BLOCK",
      findings: [{ publication_location: { path: "deleted.ts", line: 1, side: "LEFT" } }],
    },
  });
  expect(f.engine.resume).not.toHaveBeenCalled();
});
it("rejects closure current_location outside reviewed evidence without a closure retry", async () => {
  const f = await fixture(),
    prior = state(f);
  f.loadState.mockResolvedValue({
    kind: "fresh",
    previous: prior,
    history: [prior],
    rerunnable: null,
  });
  f.engine.resume.mockResolvedValue({
    run_id: runId,
    answer: JSON.stringify({
      schema_version: 1,
      resolutions: [
        {
          previous_finding_id: prior.findings[0]!.finding_id,
          status: "resolved",
          confidence: "high",
          current_location: { path: "missing.ts", line: 1, side: "RIGHT" },
          evidence: "Inspection evidence",
        },
      ],
    }),
  });
  expect(
    await runReviewPipeline({ preflight: f.preflight, workDir: f.workDir }, f.prepare, f.execute),
  ).toMatchObject({
    state: { outcome: "UNABLE_TO_REVIEW", unable_reason: "CLOSURE_RESULT_INVALID" },
  });
  expect(f.engine.resume).toHaveBeenCalledTimes(1);
});

it.each([pass, block])(
  "retains a no-history disclosure in serialized canonical PASS/BLOCK state",
  async (judge) => {
    const f = await fixture();
    f.engine.fresh.mockResolvedValue({ answer: JSON.stringify(judge), run_id: runId });
    const result = await runReviewPipeline(
      { preflight: f.preflight, workDir: f.workDir },
      f.prepare,
      f.execute,
    );
    expect(result.kind).toBe("STATE_READY");
    if (result.kind !== "STATE_READY") return;
    const saved = parseReviewState(JSON.stringify(result.state));
    expect(saved.outcome).toBe(judge.findings.length ? "BLOCK" : "PASS");
    expect(saved.judge_result?.summary).toBe(
      judge.summary +
        "\n\nNo compatible prior review was available; historical verification was not performed.",
    );
    expect(saved.judge_result?.findings).toEqual(judge.findings);
    expect(saved.findings).toEqual(state(f, head, judge).findings);
    expect(saved.resolution_result).toBeNull();
    expect(f.engine.resume).not.toHaveBeenCalled();
  },
);
it("persists partial-history disclosure while closing a surviving blocker", async () => {
  const f = await fixture(),
    previous = state(f),
    surviving = previous.findings[0]!;
  previous.previous_review_head_sha = "e".repeat(40);
  previous.resolution_result = {
    schema_version: 1,
    resolutions: [
      {
        previous_finding_id: "expired-finding-id",
        status: "still_present",
        confidence: "high",
        current_location: null,
        evidence: "Older issue was still present",
      },
    ],
  };
  f.loadState.mockResolvedValue({ kind: "fresh", previous, history: [previous], rerunnable: null });
  f.engine.resume.mockResolvedValue({
    run_id: runId,
    answer: JSON.stringify({
      schema_version: 1,
      resolutions: [
        {
          previous_finding_id: surviving.finding_id,
          status: "still_present",
          confidence: "high",
          current_location: null,
          evidence: "Retained blocker remains",
        },
      ],
    }),
  });
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result.kind).toBe("STATE_READY");
  if (result.kind !== "STATE_READY") return;
  const saved = parseReviewState(JSON.stringify(result.state));
  expect(saved.outcome).toBe("BLOCK");
  expect(saved.findings).toEqual([]);
  expect(saved.judge_result?.summary).toBe(
    pass.summary +
      "\n\nHistorical verification was incomplete because some prior findings were unavailable.",
  );
  expect(saved.resolution_result?.resolutions.map((r) => r.previous_finding_id)).toEqual([
    surviving.finding_id,
  ]);
  expect(f.engine.resume).toHaveBeenCalledTimes(1);
  expect(f.engine.resume.mock.calls[0]![0].prompt).toContain(surviving.finding_id);
  expect(f.engine.resume.mock.calls[0]![0].prompt).not.toContain("expired-finding-id");
});
it.each([pass, block])(
  "keeps the summary unchanged when compatible historical evidence is fully available",
  async (historicalJudge) => {
    const f = await fixture(),
      previous = state(f, "d".repeat(40), historicalJudge);
    f.loadState.mockResolvedValue({
      kind: "fresh",
      previous,
      history: [previous],
      rerunnable: null,
    });
    f.engine.resume.mockResolvedValue({
      run_id: runId,
      answer: JSON.stringify({
        schema_version: 1,
        resolutions: previous.findings.map((f) => ({
          previous_finding_id: f.finding_id,
          status: "resolved",
          confidence: "high",
          current_location: null,
          evidence: "Previous issue has been corrected",
        })),
      }),
    });
    const result = await runReviewPipeline(
      { preflight: f.preflight, workDir: f.workDir },
      f.prepare,
      f.execute,
    );
    expect(result.kind).toBe("STATE_READY");
    if (result.kind !== "STATE_READY") return;
    const saved = parseReviewState(JSON.stringify(result.state));
    expect(saved.outcome).toBe("PASS");
    expect(saved.judge_result?.summary).toBe(pass.summary);
  },
);
it("keeps the canonical history disclosure after sanitizing private model summary text", async () => {
  const f = await fixture();
  f.engine.fresh.mockResolvedValue({
    run_id: runId,
    answer: JSON.stringify({ ...pass, summary: "Private task title and qwen-canary" }),
  });
  const result = await runReviewPipeline(
    { preflight: f.preflight, workDir: f.workDir },
    f.prepare,
    f.execute,
  );
  expect(result.kind).toBe("STATE_READY");
  if (result.kind !== "STATE_READY") return;
  const serialized = JSON.stringify(result.state),
    saved = parseReviewState(serialized);
  expect(saved.judge_result?.summary).toBe(
    "[REDACTED PRIVATE SOURCE]\n\nNo compatible prior review was available; historical verification was not performed.",
  );
  expect(serialized).not.toMatch(/Private task title|qwen-canary/);
  expect(saved.outcome).toBe("PASS");
});
