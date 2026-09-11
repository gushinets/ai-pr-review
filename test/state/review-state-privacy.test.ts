import { describe, expect, it } from "vitest";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import { validateReviewState } from "../../src/contracts/review-state.js";
import { buildDiffIndex } from "../../src/github/diff.js";
import { buildReviewState } from "../../src/state/review-state.js";

const sources = {
  privateTexts: [
    "PRIVATE_LINEAR_REQUIREMENT_7e57 The provider token must be rotated before migration.",
    "PRIVATE_CI_LOG_4a92 database password=supersecret-value",
    "A private failed job reports confidential migration details from the internal database and deployment configuration.",
  ],
  secretValues: ["qwen-secret-123", "linear-secret-456", "github-secret-789"],
};
const diff = buildDiffIndex(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+code",
);
function inputFixture(): Omit<ReviewStateV1, "schema_version" | "findings"> {
  const attempt = {
    repository: "o/r",
    pr_number: 17,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    engine_sha: "c".repeat(40),
  };
  return {
    attempt_identity: attempt,
    review_identity: { ...attempt, linear_issue: "ANY-17" },
    lineage: { base_branch: "main", linear_issue: "ANY-17" },
    outcome: "BLOCK",
    unable_reason: null,
    ci_summary: {
      head_sha: attempt.head_sha,
      primary_ci_workflow: "CI",
      checks: [{ kind: "check_run", name: "Tests", status: "completed", conclusion: "failure" }],
    },
    judge_result: {
      schema_version: 1,
      summary: "A defect",
      findings: [
        {
          severity: "blocking",
          confidence: "high",
          title: "A defect",
          location: { path: "src/a.ts", line: 1, side: "RIGHT" },
          basis: ["code", "ci"],
          evidence: "Observed",
          rationale: "Impact",
          remediation: "Fix",
        },
      ],
    },
    resolution_result: {
      schema_version: 1,
      resolutions: [
        {
          previous_finding_id: "previous-id",
          status: "still_present",
          confidence: "high",
          current_location: null,
          evidence: "Still broken",
        },
      ],
    },
    previous_review_head_sha: "d".repeat(40),
    telemetry: {
      started_at: "2026-09-11T00:00:00Z",
      finished_at: "2026-09-11T00:00:01Z",
      duration_ms: 1000,
      models: [
        {
          role: "judge",
          model_id: "qwen",
          requested_reasoning: "high",
          effective_reasoning: "high",
        },
      ],
      judge_repair_attempts: 0,
      closure_used: true,
      rejudge_status: "completed",
      rejudge_failed_stage: null,
      input_tokens: 4,
      output_tokens: 5,
      estimated_cost_usd: 0.01,
    },
  };
}

describe("canonical privacy release blocker", () => {
  it("scans complete canonical JSON for secret canaries, every 80-character private fragment, and transcripts", () => {
    const input = inputFixture();
    input.judge_result!.summary = sources.privateTexts[0]!;
    const finding = input.judge_result!.findings[0]!;
    finding.title = sources.secretValues[0]!;
    finding.evidence = sources.privateTexts[1]!;
    finding.rationale = sources.privateTexts[2]!;
    finding.remediation = `Run ID: private-session\n${sources.secretValues[1]}`;
    input.resolution_result!.resolutions[0]!.evidence = sources.secretValues[2]!;
    input.ci_summary!.checks[0]!.name = sources.secretValues[0]!;
    input.ci_summary!.primary_ci_workflow = sources.privateTexts[1]!;
    input.telemetry.started_at = sources.secretValues[2]!;
    input.telemetry.finished_at = sources.privateTexts[0]!;
    input.telemetry.models[0]!.model_id = sources.secretValues[1]!;
    input.telemetry.models[0]!.effective_reasoning = "Run ID: raw transcript";
    const before = structuredClone(input);
    const state = buildReviewState(input, sources, diff);
    const serialized = JSON.stringify(state);
    expect(state.outcome).toBe("BLOCK");
    expect(validateReviewState(state).ok).toBe(true);
    for (const forbidden of [
      ...sources.secretValues,
      "PRIVATE_LINEAR_REQUIREMENT_7e57",
      "PRIVATE_CI_LOG_4a92",
      "supersecret-value",
      "Run ID:",
    ])
      expect(serialized).not.toContain(forbidden);
    for (const source of sources.privateTexts)
      for (let start = 0; start + 80 <= source.length; start++)
        expect(serialized).not.toContain(source.slice(start, start + 80));
    expect(state.findings[0]!.title).toBe("[REDACTED]");
    expect(state.findings[0]!.publication_location).toEqual({
      path: "src/a.ts",
      line: 1,
      side: "RIGHT",
    });
    expect(state.resolution_result!.resolutions[0]!.previous_finding_id).toBe("previous-id");
    expect(input).toEqual(before);
  });
  it.each([false, true])(
    "rejects unsafe lineage without rewriting a canonical state (fallback=%s)",
    (fallback) => {
      const input = inputFixture();
      input.lineage.base_branch = "linear-secret-456";
      if (fallback) input.judge_result!.summary = "\u0000";
      expect(() => buildReviewState(input, sources, diff)).toThrow(/^INTERNAL_ERROR$/);
      expect(input.lineage.base_branch).toBe("linear-secret-456");
    },
  );
  it("preserves the exact safe lineage when result sanitization fails", () => {
    const input = inputFixture();
    input.lineage.base_branch = "release/2026.09";
    input.judge_result!.summary = "\u0000";
    const state = buildReviewState(input, sources, diff);
    expect(state.outcome).toBe("UNABLE_TO_REVIEW");
    expect(state.lineage.base_branch).toBe("release/2026.09");
  });
  it("derives wrapper IDs from visible sanitized text", () => {
    const first = inputFixture();
    const second = inputFixture();
    first.judge_result!.findings[0]!.title = "qwen-secret-123";
    second.judge_result!.findings[0]!.title = "github-secret-789";
    const left = buildReviewState(first, sources, diff);
    const right = buildReviewState(second, sources, diff);
    expect(left.findings[0]!.finding_id).toBe(right.findings[0]!.finding_id);
    expect(left.findings[0]!.finding_id).toMatch(/^[0-9a-f]{24}$/);
    expect(left.findings[0]!.source_index).toBe(0);
    expect(left.findings[0]!.title).toBe("[REDACTED]");
  });
  it.each(["judge", "closure", "location", "closure_id", "closure_location", "metadata"])(
    "returns validated safe INTERNAL_ERROR when %s cannot survive sanitization",
    (field) => {
      const input = inputFixture();
      if (field === "judge") input.judge_result!.summary = "\u0000";
      if (field === "closure") input.resolution_result!.resolutions[0]!.evidence = "\u0000";
      if (field === "location")
        input.judge_result!.findings[0]!.location!.path = "qwen-secret-123.ts";
      if (field === "closure_id")
        input.resolution_result!.resolutions[0]!.previous_finding_id = "linear-secret-456";
      if (field === "closure_location")
        input.resolution_result!.resolutions[0]!.current_location = {
          path: "github-secret-789.ts",
          line: 1,
          side: "RIGHT",
        };
      if (field === "metadata") input.telemetry.models[0]!.model_id = "\u0000";
      const state = buildReviewState(input, sources, diff);
      expect(state).toMatchObject({
        outcome: "UNABLE_TO_REVIEW",
        unable_reason: "INTERNAL_ERROR",
        judge_result: null,
        findings: [],
        resolution_result: null,
      });
      expect(state.attempt_identity).toEqual(input.attempt_identity);
      expect(validateReviewState(state).ok).toBe(true);
      for (const secret of sources.secretValues)
        expect(JSON.stringify(state)).not.toContain(secret);
    },
  );
  it("preserves preflight unable states with no review identity or CI", () => {
    const input = inputFixture();
    Object.assign(input, {
      outcome: "UNABLE_TO_REVIEW",
      unable_reason: "PR_METADATA_INVALID",
      review_identity: null,
      judge_result: null,
      ci_summary: null,
      resolution_result: null,
    });
    input.lineage.linear_issue = null;
    const state = buildReviewState(input, sources, diff);
    expect(state).toMatchObject({
      outcome: "UNABLE_TO_REVIEW",
      unable_reason: "PR_METADATA_INVALID",
      review_identity: null,
      findings: [],
    });
  });
  it("rejects malformed trusted identity independently, with safe diagnostics", () => {
    const input = inputFixture();
    input.attempt_identity.head_sha = "qwen-secret-123";
    expect(() => buildReviewState(input, sources, diff)).toThrow(/^Invalid ReviewStateV1$/);
  });
  it("never fabricates a replacement for an unsafe required attempt identity", () => {
    const input = inputFixture();
    input.attempt_identity.repository = "o/qwen-secret-123";
    input.review_identity!.repository = input.attempt_identity.repository;
    expect(() => buildReviewState(input, sources, diff)).toThrow(/^INTERNAL_ERROR$/);
  });
  it.each(["schema_version", "17"])(
    "fails closed when a known secret equals unavoidable canonical content: %s",
    (secret) => {
      expect(() =>
        buildReviewState(
          inputFixture(),
          { ...sources, secretValues: [...sources.secretValues, secret] },
          diff,
        ),
      ).toThrow(/^INTERNAL_ERROR$/);
    },
  );
});
