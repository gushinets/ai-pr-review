import { describe, expect, it } from "vitest";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import { buildReviewState, parseReviewState } from "../../src/state/review-state.js";

function stateFixture(): ReviewStateV1 {
  const attempt = {
    repository: "o/r",
    pr_number: 17,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    engine_sha: "c".repeat(40),
  };
  return {
    schema_version: 1,
    attempt_identity: attempt,
    review_identity: { ...attempt, linear_issue: "ANY-17" },
    lineage: { base_branch: "main", linear_issue: "ANY-17" },
    outcome: "PASS",
    unable_reason: null,
    ci_summary: { head_sha: attempt.head_sha, primary_ci_workflow: "CI", checks: [] },
    judge_result: { schema_version: 1, summary: "No defects found.", findings: [] },
    findings: [],
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: "2026-09-11T00:00:00Z",
      finished_at: "2026-09-11T00:00:01Z",
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
}

describe("canonical state boundary", () => {
  it("builds and round-trips an independent, strictly validated state", () => {
    const { schema_version: _, ...input } = stateFixture();
    const built = buildReviewState(input);
    expect(parseReviewState(JSON.stringify(built))).toEqual(stateFixture());
    input.telemetry.duration_ms = 22;
    expect(built.telemetry.duration_ms).toBe(1000);
  });
  it.each([
    "linear_description",
    "linear_comments",
    "raw_linear",
    "raw_ci_log",
    "transcript",
    "prompt",
    "qwen_api_key",
    "github_token",
    "linear_client_secret",
  ])("rejects forbidden field %s at every object boundary", (key) => {
    const original = stateFixture();
    for (const altered of [
      { ...original, [key]: "private" },
      { ...original, telemetry: { ...original.telemetry, [key]: "private" } },
      { ...original, judge_result: { ...original.judge_result!, [key]: "private" } },
    ]) {
      expect(() => parseReviewState(JSON.stringify(altered))).toThrow("STATE_LOAD_FAILED");
      expect(() => buildReviewState(altered)).toThrow();
    }
    expect(JSON.stringify(buildReviewState(original))).not.toContain(`"${key}":`);
  });
  it.each([
    { schema_version: 2 },
    { extra: true },
    { outcome: "STALE_SKIPPED" },
    { outcome: "UNAUTHORIZED_SKIPPED" },
    { outcome: "UNABLE_TO_REVIEW", unable_reason: null },
    { judge_result: null },
    { unable_reason: "STATE_LOAD_FAILED" },
    { review_identity: null },
    { ci_summary: null },
  ])("rejects invalid canonical state %j", (change) => {
    expect(() => parseReviewState(JSON.stringify({ ...stateFixture(), ...change }))).toThrow(
      "STATE_LOAD_FAILED",
    );
  });
  it("allows rerunnable infrastructure failure with its reason", () => {
    const state = {
      ...stateFixture(),
      outcome: "UNABLE_TO_REVIEW" as const,
      unable_reason: "STATE_LOAD_FAILED" as const,
      judge_result: null,
    };
    expect(parseReviewState(JSON.stringify(state))).toEqual(state);
  });
  it.each(["{private broken json", "null", "[]", "42"])(
    "fails closed without echoing invalid input",
    (input) => {
      expect(() => parseReviewState(input)).toThrow(/^STATE_LOAD_FAILED$/);
    },
  );
  it("reuses nested semantic validation and identity consistency", () => {
    const state = stateFixture();
    state.attempt_identity.head_sha = "d".repeat(40);
    expect(() => parseReviewState(JSON.stringify(state))).toThrow("STATE_LOAD_FAILED");
  });
});
