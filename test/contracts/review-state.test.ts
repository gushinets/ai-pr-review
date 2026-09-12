import { expect, it } from "vitest";
import { validateReviewState } from "../../src/contracts/review-state.js";
import { parseReviewState } from "../../src/state/review-state.js";

function state() {
  const attempt = {
    repository: "o/r",
    pr_number: 1,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    engine_sha: "c".repeat(40),
  };
  return {
    schema_version: 1,
    attempt_identity: attempt,
    review_identity: { ...attempt, linear_issue: "ANY-1" },
    lineage: { base_branch: "main", linear_issue: "ANY-1" },
    outcome: "PASS",
    unable_reason: null,
    ci_summary: { head_sha: attempt.head_sha, primary_ci_workflow: "CI", checks: [] },
    judge_result: { schema_version: 1, summary: "ok", findings: [] },
    findings: [],
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: "2026-09-10T00:00:00Z",
      finished_at: "2026-09-10T00:00:01Z",
      duration_ms: 1000,
      models: [
        {
          role: "judge",
          model_id: "model-studio/qwen3.8-max-0902",
          requested_reasoning: "high",
          effective_reasoning: null,
        },
      ],
      judge_repair_attempts: 0,
      closure_used: false,
      rejudge_status: "completed",
      rejudge_failed_stage: null,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: 0.01,
    },
  };
}
it("parses old V1 state with no provider-reported model and a historical cost estimate", () => {
  expect(parseReviewState(JSON.stringify(state()))).toEqual(state());
});
it.each([undefined, null, "qwen3.8-max"])(
  "parses xhigh judge state with optional reported model %s",
  (reported) => {
    const old = state();
    const next = {
      ...old,
      telemetry: {
        ...old.telemetry,
        estimated_cost_usd: null,
        models: [
          {
            ...old.telemetry.models[0],
            model_id: "qwen-token-plan/qwen3.8-max",
            requested_reasoning: "xhigh",
            ...(reported === undefined ? {} : { provider_reported_model_id: reported }),
          },
        ],
      },
    };
    expect(parseReviewState(JSON.stringify(next))).toEqual(next);
  },
);
it.each([
  "PROVIDER_CONFIG_INVALID",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
])("requires identity and CI for %s", (reason) => {
  const unable = {
    ...state(),
    outcome: "UNABLE_TO_REVIEW",
    unable_reason: reason,
    judge_result: null,
  };
  expect(validateReviewState(unable).ok).toBe(true);
  expect(
    validateReviewState({
      ...unable,
      review_identity: null,
      lineage: { base_branch: "main", linear_issue: null },
    }).ok,
  ).toBe(false);
  expect(validateReviewState({ ...unable, ci_summary: null }).ok).toBe(false);
});
