import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { CENTRAL_CONFIG } from "../../src/config/central-config.js";
import { validateReviewState, type ReviewStateV1 } from "../../src/contracts/review-state.js";
import { renderSummary } from "../../src/publishing/summary.js";
import { createRejudgeEngine } from "../../src/review-engine/rejudge-engine.js";
import { finalizeRuntimeModelTelemetry } from "../../src/review-engine/model-telemetry.js";
import { parseRejudgeResult } from "../../src/review-engine/rejudge-worker.js";

const runId = "2026-09-15T07-00-00-000Z-abc123";
const metadata = `Run ID: ${runId}. Follow up with resumeRunId: "${runId}".`;

function stateWithTelemetry(): ReviewStateV1 {
  const attempt = {
    repository: "gushinets/fixture",
    pr_number: 7,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    engine_sha: "c".repeat(40),
  };
  const value = {
    schema_version: 1,
    attempt_identity: attempt,
    review_identity: { ...attempt, linear_issue: "ANY-499" },
    lineage: { base_branch: "main", linear_issue: "ANY-499" },
    outcome: "PASS",
    unable_reason: null,
    ci_summary: { head_sha: attempt.head_sha, primary_ci_workflow: "CI", checks: [] },
    judge_result: { schema_version: 1, summary: "ok", findings: [] },
    findings: [],
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: "2026-09-15T07:00:00Z",
      finished_at: "2026-09-15T07:01:30Z",
      duration_ms: 90_000,
      models: [
        {
          role: "reviewer_1",
          model_id: "qwen-token-plan/qwen3.8-flash",
          requested_reasoning: "medium",
          effective_reasoning: "medium",
          status: "completed",
          duration_ms: 90_000,
        },
        {
          role: "reviewer_2",
          model_id: "qwen-token-plan/deepseek-v4-pro-0813",
          requested_reasoning: "high",
          effective_reasoning: "high",
          status: "timed_out",
          duration_ms: 2_990_000,
        },
        {
          role: "reviewer_3",
          model_id: "qwen-token-plan/glm-5.2",
          requested_reasoning: "high",
          effective_reasoning: "high",
          status: "not_started",
          duration_ms: null,
        },
        {
          role: "judge",
          model_id: "qwen-token-plan/qwen3.8-max",
          requested_reasoning: "xhigh",
          effective_reasoning: "xhigh",
          status: "cancelled",
          duration_ms: 12_000,
        },
      ],
      judge_repair_attempts: 0,
      closure_used: false,
      rejudge_status: "completed",
      rejudge_failed_stage: null,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
    },
  };
  return value as unknown as ReviewStateV1;
}

it("uses a 50-minute engine deadline with a 55-minute GitHub safety ceiling", () => {
  const workflow = parse(readFileSync(".github/workflows/reusable-ai-pr-review.yml", "utf8")) as {
    jobs: { review: { "timeout-minutes": number } };
  };
  expect(CENTRAL_CONFIG.reviewTimeoutMs).toBe(50 * 60 * 1000);
  expect(workflow.jobs.review["timeout-minutes"]).toBe(55);
  expect(workflow.jobs.review["timeout-minutes"] * 60_000 - CENTRAL_CONFIG.reviewTimeoutMs).toBe(
    5 * 60_000,
  );
});

it("accepts new per-model status/duration fields and renders them in technical details", () => {
  const state = stateWithTelemetry();
  expect(validateReviewState(state).ok).toBe(true);
  const summary = renderSummary(state);
  expect(summary).toContain("reviewer_1");
  expect(summary).toContain("Status: completed");
  expect(summary).toContain("Duration: 1m 30s");
  expect(summary).toContain("Status: timed&#95;out");
  expect(summary).toContain("Status: not&#95;started");
  expect(summary).toContain("Status: cancelled");
});

it("keeps old V1 model records without timing fields valid", () => {
  const state = stateWithTelemetry();
  state.telemetry.models = state.telemetry.models.map((model) => {
    const {
      status: _status,
      duration_ms: _duration,
      ...legacy
    } = model as typeof model & { status?: string; duration_ms?: number | null };
    return legacy;
  });
  expect(validateReviewState(state).ok).toBe(true);
});

it("extracts only whitelisted per-model timing from Rejudge progress details", () => {
  const response = parseRejudgeResult(
    {
      content: [{ type: "text", text: `answer\n${metadata}` }],
      details: {
        models: [
          {
            roleKey: "panel-1",
            model: "qwen-token-plan/qwen3.8-flash",
            role: "reviewer",
            status: "done",
            startedAt: 1_000,
            endedAt: 91_000,
            toolCount: 3,
            error: "PRIVATE_PROVIDER_BODY",
            detail: "PRIVATE_MODEL_TEXT",
          },
          {
            roleKey: "panel-2",
            model: "qwen-token-plan/deepseek-v4-pro-0813",
            role: "reviewer",
            status: "running",
            startedAt: 2_000,
            toolCount: 1,
            detail: "PRIVATE_THINKING",
          },
        ],
      },
    },
    "fresh",
  );
  expect(response).toMatchObject({
    ok: true,
    model_telemetry: [
      { role: "reviewer_1", status: "completed", duration_ms: 90_000 },
      { role: "reviewer_2", status: "running", duration_ms: null, started_at_ms: 2_000 },
    ],
  });
  expect(JSON.stringify(response)).not.toMatch(
    /PRIVATE_PROVIDER_BODY|PRIVATE_MODEL_TEXT|PRIVATE_THINKING/,
  );
});

it("turns a still-running model into timed_out with partial duration at the deadline", () => {
  expect(
    finalizeRuntimeModelTelemetry(
      [
        {
          role: "reviewer_2",
          status: "running",
          started_at_ms: 1_000,
          duration_ms: null,
        },
      ],
      "deadline",
      61_000,
    ),
  ).toEqual([{ role: "reviewer_2", status: "timed_out", duration_ms: 60_000 }]);
});

it("exposes four not-started model slots before any review work begins", () => {
  const engine = createRejudgeEngine();
  expect(engine.modelTelemetry).toBeTypeOf("function");
  expect(engine.modelTelemetry!("/not-started")).toEqual([
    { role: "reviewer_1", status: "not_started", duration_ms: null },
    { role: "reviewer_2", status: "not_started", duration_ms: null },
    { role: "reviewer_3", status: "not_started", duration_ms: null },
    { role: "judge", status: "not_started", duration_ms: null },
  ]);
});
