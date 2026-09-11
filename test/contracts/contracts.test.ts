import { describe, expect, it } from "vitest";
import { validateJudgeResult } from "../../src/contracts/judge-result.js";
import { validateRepoConfig } from "../../src/contracts/repo-config.js";
import { validateResolutionResult } from "../../src/contracts/resolution-result.js";
import { validateReviewIdentity } from "../../src/contracts/review-identity.js";
import { validateReviewContext } from "../../src/contracts/review-context.js";
import { validateReviewState } from "../../src/contracts/review-state.js";

const finding = {
  severity: "blocking",
  confidence: "high",
  title: "x",
  location: { path: "src/a.ts", line: 1, side: "RIGHT" },
  basis: ["code"],
  evidence: "observed",
  rationale: "matters",
  remediation: "fix it",
} as const;

const baseSha = "1111111111111111111111111111111111111111";
const headSha = "2222222222222222222222222222222222222222";
const engineSha = "3333333333333333333333333333333333333333";
const identity = {
  repository: "gushinets/ai-pr-review",
  pr_number: 4,
  base_sha: baseSha,
  head_sha: headSha,
  linear_issue: "ANY-123",
  engine_sha: engineSha,
};

describe("JudgeResultV1", () => {
  it("accepts the minimal valid result", () => {
    expect(validateJudgeResult({ schema_version: 1, summary: "ok", findings: [] }).ok).toBe(true);
  });

  it("requires high confidence for blocking findings", () => {
    expect(
      validateJudgeResult({
        schema_version: 1,
        summary: "x",
        findings: [{ ...finding, confidence: "medium" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a model-supplied verdict", () => {
    expect(
      validateJudgeResult({ schema_version: 1, summary: "ok", findings: [], verdict: "PASS" }).ok,
    ).toBe(false);
  });

  it.each([
    [
      "more than 20 findings",
      { schema_version: 1, summary: "x", findings: Array(21).fill(finding) },
    ],
    [
      "an unknown severity",
      { schema_version: 1, summary: "x", findings: [{ ...finding, severity: "critical" }] },
    ],
    [
      "empty evidence",
      { schema_version: 1, summary: "x", findings: [{ ...finding, evidence: "" }] },
    ],
    [
      "a non-positive location line",
      {
        schema_version: 1,
        summary: "x",
        findings: [{ ...finding, location: { path: "src/a.ts", line: 0, side: "RIGHT" } }],
      },
    ],
    [
      "an unknown top-level property",
      { schema_version: 1, summary: "x", findings: [], extra: true },
    ],
    [
      "an unknown finding property",
      { schema_version: 1, summary: "x", findings: [{ ...finding, extra: true }] },
    ],
    [
      "an unknown location property",
      {
        schema_version: 1,
        summary: "x",
        findings: [{ ...finding, location: { ...finding.location, extra: true } }],
      },
    ],
    [
      "a non-relative path",
      {
        schema_version: 1,
        summary: "x",
        findings: [{ ...finding, location: { ...finding.location, path: "../a.ts" } }],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(validateJudgeResult(value).ok).toBe(false);
  });
});

describe("other V1 schemas", () => {
  it("rejects malformed trusted review identities", () => {
    expect(validateReviewIdentity(identity).ok).toBe(true);
    expect(validateReviewIdentity({ ...identity, repository: "repo" }).ok).toBe(false);
    expect(validateReviewIdentity({ ...identity, repository: "owner name/repo" }).ok).toBe(false);
    expect(validateReviewIdentity({ ...identity, linear_issue: "ENG-1" }).ok).toBe(false);
    expect(validateReviewIdentity({ ...identity, pr_number: 0 }).ok).toBe(false);
    expect(validateReviewIdentity({ ...identity, head_sha: "head" }).ok).toBe(false);
    expect(validateReviewIdentity({ ...identity, linear_issue: "issue-1" }).ok).toBe(false);
  });

  it("validates strict repository configuration", () => {
    const config = {
      version: 1,
      primary_ci_workflow: "CI",
      policy: {
        always: ["AGENTS.md"],
        scoped: [{ paths: ["src/**"], include: ["src/AGENTS.md"] }],
      },
    };
    expect(validateRepoConfig(config).ok).toBe(true);
    expect(validateRepoConfig({ ...config, maxFindings: 99 }).ok).toBe(false);
    expect(validateRepoConfig({ ...config, policy: { ...config.policy, extra: true } }).ok).toBe(
      false,
    );
    expect(
      validateRepoConfig({ ...config, policy: { ...config.policy, always: ["../AGENTS.md"] } }).ok,
    ).toBe(false);
  });

  it("validates strict resolution results", () => {
    const resolution = {
      schema_version: 1,
      resolutions: [
        {
          previous_finding_id: "finding-abc",
          status: "resolved",
          confidence: "high",
          current_location: null,
          evidence: "gone",
        },
      ],
    };
    expect(validateResolutionResult(resolution).ok).toBe(true);
    expect(
      validateResolutionResult({
        ...resolution,
        resolutions: [{ ...resolution.resolutions[0], confidence: "medium" }],
      }).ok,
    ).toBe(false);
    expect(validateResolutionResult({ ...resolution, verdict: "PASS" }).ok).toBe(false);
    expect(
      validateResolutionResult({
        ...resolution,
        resolutions: [{ ...resolution.resolutions[0], evidence: "" }],
      }).ok,
    ).toBe(false);
  });

  it("validates the final deterministic review context shape", () => {
    const context = {
      schema_version: 1,
      review_identity: identity,

      base_branch: "main",
      changed_files: ["src/a.ts"],
      diff_stats: { files: 1, additions: 2, deletions: 0 },
      policy_paths: ["control/policy/AGENTS.md"],
      requirements_path: "requirements/linear.json",
      ci: { schema_version: 1, head_sha: headSha, primary_ci_workflow: "CI", checks: [] },
      diff_path: "diff/pr.diff",
    };
    expect(validateReviewContext(context).ok).toBe(true);
    expect(validateReviewContext({ ...context, raw_linear: "secret" }).ok).toBe(false);
    expect(validateReviewContext({ ...context, changed_files: ["../escape"] }).ok).toBe(false);
    expect(validateReviewContext({ ...context, changed_files: ["z.ts", "a.ts"] }).ok).toBe(false);
    expect(validateReviewContext({ ...context, ci: { ...context.ci, head_sha: baseSha } }).ok).toBe(
      false,
    );
  });

  it("enforces persisted state identity and outcome invariants", () => {
    const attempt = {
      repository: "gushinets/ai-pr-review",
      pr_number: 4,
      base_sha: baseSha,
      head_sha: headSha,
      engine_sha: engineSha,
    };
    const identity = { ...attempt, linear_issue: "ANY-123" };
    const state = {
      schema_version: 1,
      attempt_identity: attempt,
      review_identity: identity,
      lineage: { base_branch: "main", linear_issue: "ANY-123" },
      outcome: "PASS",
      unable_reason: null,
      ci_summary: { head_sha: headSha, primary_ci_workflow: "CI", checks: [] },
      judge_result: { schema_version: 1, summary: "ok", findings: [] },
      findings: [],
      resolution_result: null,
      previous_review_head_sha: null,
      telemetry: {
        started_at: "2026-09-10T00:00:00Z",
        finished_at: "2026-09-10T00:00:01Z",
        duration_ms: 1000,
        models: [],
        judge_repair_attempts: 0,
        closure_used: false,
        rejudge_status: "completed",
        rejudge_failed_stage: null,
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null,
      },
    };
    expect(validateReviewState(state).ok).toBe(true);
    expect(
      validateReviewState({
        ...state,
        attempt_identity: {
          engine_sha: engineSha,
          head_sha: headSha,
          base_sha: baseSha,
          pr_number: 4,
          repository: "gushinets/ai-pr-review",
        },
      }).ok,
    ).toBe(true);
    expect(validateReviewState({ ...state, unable_reason: "INTERNAL_ERROR" }).ok).toBe(false);
    expect(
      validateReviewState({ ...state, attempt_identity: { ...attempt, head_sha: "other" } }).ok,
    ).toBe(false);
    expect(
      validateReviewState({ ...state, lineage: { ...state.lineage, linear_issue: "ENG-2" } }).ok,
    ).toBe(false);
    expect(
      validateReviewState({
        ...state,
        findings: [
          {
            ...finding,
            confidence: "medium",
            finding_id: "finding-1",
            source_index: 0,
            publication_location: null,
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateReviewState({
        ...state,
        resolution_result: {
          schema_version: 1,
          resolutions: [
            {
              previous_finding_id: "finding-1",
              status: "resolved",
              confidence: "medium",
              current_location: null,
              evidence: "gone",
            },
          ],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateReviewState({
        ...state,
        outcome: "UNABLE_TO_REVIEW",
        review_identity: null,
        lineage: { ...state.lineage, linear_issue: null },
        unable_reason: "JUDGE_RESULT_INVALID",
        ci_summary: null,
        judge_result: null,
      }).ok,
    ).toBe(false);
    expect(
      validateReviewState({
        ...state,
        outcome: "UNABLE_TO_REVIEW",
        unable_reason: "SNAPSHOT_FAILED",
        ci_summary: null,
        judge_result: null,
      }).ok,
    ).toBe(false);
    expect(
      validateReviewState({
        ...state,
        outcome: "UNABLE_TO_REVIEW",
        review_identity: null,
        lineage: { ...state.lineage, linear_issue: null },
        unable_reason: "PR_METADATA_INVALID",
        ci_summary: null,
        judge_result: null,
      }).ok,
    ).toBe(true);
  });
});
