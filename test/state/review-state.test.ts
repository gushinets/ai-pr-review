import { describe, expect, it } from "vitest";
import { buildDiffIndex } from "../../src/github/diff.js";
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
    const { schema_version: _, findings: _findings, ...input } = stateFixture();
    const built = buildReviewState(
      input,
      { privateTexts: [], secretValues: [] },
      buildDiffIndex(""),
    );
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
      const { schema_version: _, findings: _findings, ...input } = altered;
      expect(() =>
        buildReviewState(input, { privateTexts: [], secretValues: [] }, buildDiffIndex("")),
      ).toThrow();
    }
    const { schema_version: _, findings: _findings, ...input } = original;
    expect(
      JSON.stringify(
        buildReviewState(input, { privateTexts: [], secretValues: [] }, buildDiffIndex("")),
      ),
    ).not.toContain(`"${key}":`);
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
describe("fixed history annotation privacy boundary", () => {
  it.each(["available", "prior review"])(
    "retains central no-history prose when private source is %j",
    (word) => {
      const { schema_version: _, findings: _findings, ...input } = stateFixture();
      input.judge_result!.summary = "Model-private-summary-canary";
      const built = buildReviewState(
        input,
        { privateTexts: [word, "Model-private-summary-canary"], secretValues: [] },
        buildDiffIndex(""),
        "unavailable",
      );
      const saved = parseReviewState(JSON.stringify(built));
      expect(saved.outcome).toBe("PASS");
      expect(saved.judge_result?.summary).toBe(
        "[REDACTED PRIVATE SOURCE]\n\nNo compatible prior review was available; historical verification was not performed.",
      );
      expect(JSON.stringify(saved)).not.toContain("Model-private-summary-canary");
    },
  );
  it("retains only fixed incomplete-history prose despite a private word overlap", () => {
    const { schema_version: _, findings: _findings, ...input } = stateFixture();
    const built = buildReviewState(
      input,
      { privateTexts: ["available"], secretValues: [] },
      buildDiffIndex(""),
      "incomplete",
    );
    expect(parseReviewState(JSON.stringify(built)).judge_result?.summary).toBe(
      input.judge_result!.summary +
        "\n\nHistorical verification was incomplete because some prior findings were unavailable.",
    );
  });
  it("keeps default and complete-history payloads exactly unchanged", () => {
    const { schema_version: _, findings: _findings, ...input } = stateFixture();
    const sources = { privateTexts: ["available"], secretValues: [] };
    expect(buildReviewState(input, sources, buildDiffIndex(""))).toEqual(stateFixture());
    expect(buildReviewState(input, sources, buildDiffIndex(""), "complete")).toEqual(
      stateFixture(),
    );
  });
  it.each(["arbitrary trusted prose", "__proto__", null, {}])(
    "rejects invalid annotation enum %j",
    (value) => {
      const { schema_version: _, findings: _findings, ...input } = stateFixture();
      expect(() =>
        buildReviewState(
          input,
          { privateTexts: [], secretValues: [] },
          buildDiffIndex(""),
          value as never,
        ),
      ).toThrow();
    },
  );
  it("fails closed if the fixed template contains an exact known secret", () => {
    const { schema_version: _, findings: _findings, ...input } = stateFixture();
    const built = buildReviewState(
      input,
      { privateTexts: [], secretValues: ["prior review"] },
      buildDiffIndex(""),
      "unavailable",
    );
    expect(parseReviewState(JSON.stringify(built))).toMatchObject({
      outcome: "UNABLE_TO_REVIEW",
      unable_reason: "INTERNAL_ERROR",
      judge_result: null,
      findings: [],
    });
    expect(JSON.stringify(built)).not.toContain("prior review");
  });
  it("throws if a template credential collision also makes the fallback unsafe", () => {
    const { schema_version: _, findings: _findings, ...input } = stateFixture();
    expect(() =>
      buildReviewState(
        input,
        { privateTexts: [], secretValues: ["available"] },
        buildDiffIndex(""),
        "unavailable",
      ),
    ).toThrow();
  });
});
