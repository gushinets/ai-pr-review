import { expect, it } from "vitest";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import { experimentArtifactName, recordExperimentTelemetry } from "../../src/graph/experiment.js";

const identity = {
  repository: "owner/repository",
  pr_number: 2,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  engine_sha: "c".repeat(40),
};
function state(): ReviewStateV1 {
  return {
    schema_version: 1,
    attempt_identity: identity,
    review_identity: { ...identity, linear_issue: null },
    lineage: { base_branch: "main", linear_issue: null },
    outcome: "PASS",
    unable_reason: null,
    ci_summary: { head_sha: identity.head_sha, primary_ci_workflow: "CI", checks: [] },
    judge_result: { schema_version: 1, summary: "PRIVATE_RAW_SOURCE", findings: [] },
    findings: [],
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: "2026-10-02",
      finished_at: "2026-10-02",
      duration_ms: 1000,
      models: [
        {
          role: "judge",
          model_id: "vendor/model",
          requested_reasoning: "high",
          effective_reasoning: null,
        },
      ],
      judge_repair_attempts: 0,
      closure_used: false,
      rejudge_status: "completed",
      rejudge_failed_stage: null,
      input_tokens: null,
      output_tokens: 42,
      estimated_cost_usd: null,
    },
  };
}
it("records only aggregate evaluation telemetry with exact identity and null unavailable usage", () => {
  const result = recordExperimentTelemetry(state(), "codegraph", {
    status: "failed",
    failure_code: "TIMEOUT",
  });
  expect(result).toMatchObject({
    schema_version: 1,
    ...identity,
    graph_variant: "codegraph",
    graph_status: "failed",
    graph_failure_code: "TIMEOUT",
    findings_count: 0,
    blocking_findings_count: 0,
    input_tokens: null,
    output_tokens: 42,
    latency_ms: 1000,
  });
  expect(result.model_panel).toEqual([
    { role: "judge", model_id: "vendor/model", requested_reasoning: "high" },
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_RAW_SOURCE");
  expect(Object.keys(result)).not.toContain("judge_result");
});
it("keeps experiment artifacts distinct across repository, HEAD, engine, and graph arm", () => {
  const name = experimentArtifactName(identity, "off");
  expect(name).toMatch(/^ai-review-experiment-v1-/);
  for (const other of [
    { ...identity, repository: "other/repository" },
    { ...identity, head_sha: "d".repeat(40) },
    { ...identity, engine_sha: "e".repeat(40) },
  ])
    expect(experimentArtifactName(other, "off")).not.toBe(name);
  expect(experimentArtifactName(identity, "codegraph")).not.toBe(name);
});
it("rejects malformed telemetry and secret-bearing model IDs without echoing raw data", () => {
  const invalid = state();
  invalid.telemetry.models[0]!.model_id = "TOKEN\nRAW_SOURCE";
  expect(() =>
    recordExperimentTelemetry(invalid, "off", { status: "off", failure_code: null }),
  ).toThrow(/^INVALID_EXPERIMENT_TELEMETRY$/);
});
