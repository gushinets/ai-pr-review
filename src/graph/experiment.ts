import { createHash } from "node:crypto";
import type { ReviewAttemptIdentityV1 } from "../contracts/review-identity.js";
import { validateReviewState, type ReviewStateV1 } from "../contracts/review-state.js";
import type { GraphFailureCode, GraphStatus } from "./prepare.js";

export type GraphVariant = "off" | "codegraph";
export interface ExperimentTelemetry extends ReviewAttemptIdentityV1 {
  schema_version: 1;
  graph_variant: GraphVariant;
  graph_status: GraphStatus;
  graph_failure_code: GraphFailureCode | null;
  model_panel: Array<{ role: string; model_id: string; requested_reasoning: string }>;
  outcome: ReviewStateV1["outcome"];
  findings_count: number;
  blocking_findings_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
}
const failureCodes = new Set([
  "UNSAFE_INPUT",
  "INPUT_LIMIT",
  "UNAVAILABLE",
  "TIMEOUT",
  "OUTPUT_LIMIT",
  "PROCESS_FAILED",
  "INVALID_OUTPUT",
  "ARTIFACT_IO",
]);
function validIdentity(identity: ReviewAttemptIdentityV1): boolean {
  return (
    /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(identity.repository) &&
    Number.isSafeInteger(identity.pr_number) &&
    identity.pr_number > 0 &&
    [identity.base_sha, identity.head_sha, identity.engine_sha].every((sha) =>
      /^[0-9a-f]{40}$/i.test(sha),
    )
  );
}
function reject(): never {
  throw new Error("INVALID_EXPERIMENT_TELEMETRY");
}

export function recordExperimentTelemetry(
  state: ReviewStateV1,
  variant: GraphVariant,
  graph: { status: GraphStatus; failure_code: GraphFailureCode | null },
): ExperimentTelemetry {
  if (
    !validateReviewState(state).ok ||
    !validIdentity(state.attempt_identity) ||
    !["off", "codegraph"].includes(variant) ||
    !["off", "completed", "failed"].includes(graph.status) ||
    (graph.status === "failed"
      ? !failureCodes.has(String(graph.failure_code))
      : graph.failure_code !== null) ||
    (variant === "off" ? graph.status !== "off" : graph.status === "off")
  )
    reject();
  const model_panel = state.telemetry.models.map((model) => {
    if (!/^[A-Za-z0-9._:/@+-]{1,160}$/.test(model.model_id)) reject();
    return {
      role: model.role,
      model_id: model.model_id,
      requested_reasoning: model.requested_reasoning,
    };
  });
  // Aggregate only: findings, source, prompts, private requirements and transcripts never enter this record.
  return {
    schema_version: 1,
    ...state.attempt_identity,
    graph_variant: variant,
    graph_status: graph.status,
    graph_failure_code: graph.failure_code,
    model_panel,
    outcome: state.outcome,
    findings_count: state.findings.length,
    blocking_findings_count: state.findings.filter((finding) => finding.severity === "blocking")
      .length,
    input_tokens: state.telemetry.input_tokens,
    output_tokens: state.telemetry.output_tokens,
    latency_ms: state.telemetry.duration_ms,
  };
}

export function experimentArtifactName(
  identity: ReviewAttemptIdentityV1,
  variant: GraphVariant,
): string {
  if (!validIdentity(identity) || !["off", "codegraph"].includes(variant)) reject();
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        identity.repository.toLowerCase(),
        identity.pr_number,
        identity.base_sha.toLowerCase(),
        identity.head_sha.toLowerCase(),
        identity.engine_sha.toLowerCase(),
      ]),
    )
    .digest("hex");
  return `ai-review-experiment-v1-${digest}-pr-${identity.pr_number}-${variant}`;
}
