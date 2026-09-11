import type { DiffIndex } from "../contracts/review-context.js";
import { validateReviewState, type ReviewStateV1 } from "../contracts/review-state.js";
import { buildReviewFindings } from "../publishing/findings.js";
import {
  assertDurableValues,
  sanitizeDurableText,
  sanitizeJudgeResult,
  sanitizeResolutionResult,
  type SanitizationSources,
} from "../publishing/sanitize.js";

export type SanitizedReviewPayloadV1 = ReviewStateV1;

export function buildReviewState(
  input: Omit<ReviewStateV1, "schema_version" | "findings">,
  sources: SanitizationSources,
  diff: DiffIndex,
): SanitizedReviewPayloadV1 {
  // Validate trusted identity and ephemeral contracts independently of privacy failure.
  if ("schema_version" in input || "findings" in input) throw new Error("Invalid ReviewStateV1");
  const validated = validateReviewState({ ...input, schema_version: 1, findings: [] });
  if (!validated.ok) throw new Error("Invalid ReviewStateV1");
  const state = structuredClone(validated.value);
  assertDurableValues(state.attempt_identity, sources);
  const sanitize = (text: string) => sanitizeDurableText(text, sources);
  try {
    state.lineage.base_branch = sanitize(state.lineage.base_branch);
    if (state.ci_summary !== null) {
      state.ci_summary.primary_ci_workflow = sanitize(state.ci_summary.primary_ci_workflow);
      for (const check of state.ci_summary.checks) check.name = sanitize(check.name);
    }
    state.telemetry.started_at = sanitize(state.telemetry.started_at);
    state.telemetry.finished_at = sanitize(state.telemetry.finished_at);
    for (const model of state.telemetry.models) {
      model.model_id = sanitize(model.model_id);
      if (model.effective_reasoning !== null)
        model.effective_reasoning = sanitize(model.effective_reasoning);
    }
    if (state.judge_result !== null) {
      state.judge_result = sanitizeJudgeResult(state.judge_result, sources);
      if (state.review_identity === null) throw new Error("INTERNAL_ERROR");
      state.findings = buildReviewFindings(state.judge_result, state.review_identity, diff);
    }
    if (state.resolution_result !== null)
      state.resolution_result = sanitizeResolutionResult(state.resolution_result, sources);
    if (!validateReviewState(state).ok) throw new Error("INTERNAL_ERROR");
    assertDurableValues(state, sources);
    return state;
  } catch {
    // Drop unsafe results and nonessential metadata. Never invent a replacement identity.
    try {
      assertDurableValues(state.review_identity, sources);
    } catch {
      state.review_identity = null;
    }
    const failed: ReviewStateV1 = {
      schema_version: 1,
      attempt_identity: state.attempt_identity,
      review_identity: state.review_identity,
      lineage: {
        base_branch: sanitize(input.lineage.base_branch) || "[REDACTED]",
        linear_issue: state.review_identity?.linear_issue ?? null,
      },
      outcome: "UNABLE_TO_REVIEW",
      unable_reason: "INTERNAL_ERROR",
      ci_summary: null,
      judge_result: null,
      findings: [],
      resolution_result: null,
      previous_review_head_sha: null,
      telemetry: {
        started_at: "unavailable",
        finished_at: "unavailable",
        duration_ms: input.telemetry.duration_ms,
        models: [],
        judge_repair_attempts: 0,
        closure_used: false,
        rejudge_status: "not_started",
        rejudge_failed_stage: null,
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null,
      },
    };
    if (!validateReviewState(failed).ok) throw new Error("INTERNAL_ERROR");
    assertDurableValues(failed, sources);
    return failed;
  }
}

export function parseReviewState(input: string): ReviewStateV1 {
  try {
    const validated = validateReviewState(JSON.parse(input));
    if (validated.ok) return validated.value;
  } catch {
    // Never echo artifact contents or parser messages into public diagnostics.
  }
  throw new Error("STATE_LOAD_FAILED");
}
