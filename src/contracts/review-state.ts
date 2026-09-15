import Schema from "typebox/schema";
import { Type } from "typebox";
import {
  isRepositoryRelativePath,
  type PersistedOutcome,
  type ValidationResult,
} from "./common.js";
import { UNABLE_REASONS, type UnableReason } from "./failure-reasons.js";
import {
  JudgeFindingV1Schema,
  JudgeLocationV1Schema,
  JudgeResultV1Schema,
  type JudgeFindingV1,
  type JudgeLocationV1,
  type JudgeResultV1,
  validateJudgeResult,
} from "./judge-result.js";
import {
  ResolutionResultV1Schema,
  type ResolutionResultV1,
  validateResolutionResult,
} from "./resolution-result.js";
import {
  ReviewAttemptIdentityV1Schema,
  ReviewIdentityV1Schema,
  type ReviewAttemptIdentityV1,
  type ReviewIdentityV1,
} from "./review-identity.js";
import type { CiCheckConclusion, CiCheckKind, CiCheckStatus } from "./review-context.js";

export interface PersistedCiSummaryV1 {
  head_sha: string;
  primary_ci_workflow: string;
  checks: Array<{
    kind: CiCheckKind;
    name: string;
    status: CiCheckStatus;
    conclusion: CiCheckConclusion;
  }>;
}

export interface ReviewFindingV1 extends JudgeFindingV1 {
  finding_id: string;
  source_index: number;
  publication_location: JudgeLocationV1 | null;
}

export interface ReviewStateV1 {
  schema_version: 1;
  attempt_identity: ReviewAttemptIdentityV1;
  review_identity: ReviewIdentityV1 | null;
  lineage: { base_branch: string; linear_issue: string | null };
  outcome: PersistedOutcome;
  unable_reason: UnableReason | null;
  ci_summary: PersistedCiSummaryV1 | null;
  judge_result: JudgeResultV1 | null;
  findings: ReviewFindingV1[];
  resolution_result: ResolutionResultV1 | null;
  previous_review_head_sha: string | null;
  telemetry: {
    started_at: string;
    finished_at: string;
    duration_ms: number;
    models: Array<{
      role: "reviewer_1" | "reviewer_2" | "reviewer_3" | "judge";
      model_id: string;
      requested_reasoning: "medium" | "high" | "xhigh";
      provider_reported_model_id?: string | null;
      effective_reasoning: string | null;
      status?: "not_started" | "completed" | "failed" | "timed_out" | "cancelled";
      duration_ms?: number | null;
    }>;
    judge_repair_attempts: 0 | 1;
    closure_used: boolean;
    rejudge_status: "not_started" | "completed" | "failed";
    rejudge_failed_stage: "panel" | "judge" | "resume" | null;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_usd: number | null;
  };
}

const checkSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("check_run"), Type.Literal("commit_status")]),
    name: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("waiting"),
      Type.Literal("requested"),
      Type.Literal("pending"),
    ]),
    conclusion: Type.Union([
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Literal("cancelled"),
      Type.Literal("timed_out"),
      Type.Literal("action_required"),
      Type.Literal("neutral"),
      Type.Literal("skipped"),
      Type.Literal("stale"),
      Type.Literal("startup_failure"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const PersistedCiSummaryV1Schema = Type.Object(
  {
    head_sha: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
    primary_ci_workflow: Type.String({ minLength: 1 }),
    checks: Type.Array(checkSchema),
  },
  { additionalProperties: false },
);

export const ReviewFindingV1Schema = Type.Object(
  {
    ...JudgeFindingV1Schema.properties,
    finding_id: Type.String({ minLength: 1 }),
    source_index: Type.Integer({ minimum: 0 }),
    publication_location: Type.Union([JudgeLocationV1Schema, Type.Null()]),
  },
  { additionalProperties: false },
);

const modelSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal("reviewer_1"),
      Type.Literal("reviewer_2"),
      Type.Literal("reviewer_3"),
      Type.Literal("judge"),
    ]),
    model_id: Type.String({ minLength: 1 }),
    requested_reasoning: Type.Union([
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
    provider_reported_model_id: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    ),
    effective_reasoning: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: Type.Optional(
      Type.Union([
        Type.Literal("not_started"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("timed_out"),
        Type.Literal("cancelled"),
      ]),
    ),
    duration_ms: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  },
  { additionalProperties: false },
);

const nullableNonNegativeInteger = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const nullableNonNegativeNumber = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);

export const ReviewStateV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    attempt_identity: ReviewAttemptIdentityV1Schema,
    review_identity: Type.Union([ReviewIdentityV1Schema, Type.Null()]),
    lineage: Type.Object(
      {
        base_branch: Type.String({ minLength: 1 }),
        linear_issue: Type.Union([Type.String({ pattern: "^ANY-[1-9][0-9]*$" }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    outcome: Type.Union([
      Type.Literal("PASS"),
      Type.Literal("BLOCK"),
      Type.Literal("UNABLE_TO_REVIEW"),
    ]),
    unable_reason: Type.Union([
      ...UNABLE_REASONS.map((reason) => Type.Literal(reason)),
      Type.Null(),
    ]),
    ci_summary: Type.Union([PersistedCiSummaryV1Schema, Type.Null()]),
    judge_result: Type.Union([JudgeResultV1Schema, Type.Null()]),
    findings: Type.Array(ReviewFindingV1Schema, { maxItems: 20 }),
    resolution_result: Type.Union([ResolutionResultV1Schema, Type.Null()]),
    previous_review_head_sha: Type.Union([
      Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
      Type.Null(),
    ]),
    telemetry: Type.Object(
      {
        started_at: Type.String({ minLength: 1 }),
        finished_at: Type.String({ minLength: 1 }),
        duration_ms: Type.Number({ minimum: 0 }),
        models: Type.Array(modelSchema),
        judge_repair_attempts: Type.Union([Type.Literal(0), Type.Literal(1)]),
        closure_used: Type.Boolean(),
        rejudge_status: Type.Union([
          Type.Literal("not_started"),
          Type.Literal("completed"),
          Type.Literal("failed"),
        ]),
        rejudge_failed_stage: Type.Union([
          Type.Literal("panel"),
          Type.Literal("judge"),
          Type.Literal("resume"),
          Type.Null(),
        ]),
        input_tokens: nullableNonNegativeInteger,
        output_tokens: nullableNonNegativeInteger,
        estimated_cost_usd: nullableNonNegativeNumber,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const validator = Schema.Compile(ReviewStateV1Schema);

const identityRequiredReasons = new Set<UnableReason>([
  "PROVIDER_CONFIG_INVALID",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "POLICY_MISSING",
  "PR_TOO_LARGE",
  "LINEAR_AUTH_FAILED",
  "LINEAR_NOT_FOUND",
  "LINEAR_UNAVAILABLE",
  "LINEAR_CONTEXT_TOO_LARGE",
  "CI_CONTEXT_UNAVAILABLE",
  "SNAPSHOT_FAILED",
  "STATE_LOAD_FAILED",
  "REJUDGE_PANEL_FAILED",
  "REJUDGE_JUDGE_FAILED",
  "JUDGE_RESULT_INVALID",
  "JUDGE_REPAIR_FAILED",
  "CLOSURE_FAILED",
  "CLOSURE_RESULT_INVALID",
]);

const ciRequiredReasons = new Set<UnableReason>([
  "PROVIDER_CONFIG_INVALID",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "SNAPSHOT_FAILED",
  "REJUDGE_PANEL_FAILED",
  "REJUDGE_JUDGE_FAILED",
  "JUDGE_RESULT_INVALID",
  "JUDGE_REPAIR_FAILED",
  "CLOSURE_FAILED",
  "CLOSURE_RESULT_INVALID",
]);

export function validateReviewState(value: unknown): ValidationResult<ReviewStateV1> {
  if (!validator.Check(value)) return { ok: false, errors: ["Invalid ReviewStateV1 schema"] };
  const state = value as ReviewStateV1;
  const contentOutcome = state.outcome === "PASS" || state.outcome === "BLOCK";
  if (
    (contentOutcome &&
      (state.review_identity === null ||
        state.unable_reason !== null ||
        state.judge_result === null ||
        state.ci_summary === null)) ||
    (state.outcome === "UNABLE_TO_REVIEW" && state.unable_reason === null) ||
    (state.unable_reason !== null &&
      identityRequiredReasons.has(state.unable_reason) &&
      state.review_identity === null) ||
    (state.unable_reason !== null &&
      ciRequiredReasons.has(state.unable_reason) &&
      state.ci_summary === null) ||
    (state.review_identity === null && state.lineage.linear_issue !== null) ||
    (state.ci_summary !== null && state.ci_summary.head_sha !== state.attempt_identity.head_sha)
  )
    return { ok: false, errors: ["ReviewStateV1 outcome invariant failed"] };
  if (state.review_identity !== null) {
    const identity = state.review_identity;
    const attempt = state.attempt_identity;
    if (
      identity.repository !== attempt.repository ||
      identity.pr_number !== attempt.pr_number ||
      identity.base_sha !== attempt.base_sha ||
      identity.head_sha !== attempt.head_sha ||
      identity.engine_sha !== attempt.engine_sha ||
      state.lineage.linear_issue !== identity.linear_issue
    ) {
      return { ok: false, errors: ["ReviewStateV1 identity invariant failed"] };
    }
  }
  const persistedFindingsValid = validateJudgeResult({
    schema_version: 1,
    summary: "persisted findings",
    findings: state.findings.map(
      ({
        finding_id: _findingId,
        source_index: _sourceIndex,
        publication_location: _publication,
        ...finding
      }) => finding,
    ),
  }).ok;
  const publicationLocationsValid = state.findings.every(
    (finding) =>
      finding.finding_id.trim() &&
      (finding.publication_location === null ||
        isRepositoryRelativePath(finding.publication_location.path)),
  );
  if (
    (state.judge_result !== null && !validateJudgeResult(state.judge_result).ok) ||
    (state.resolution_result !== null && !validateResolutionResult(state.resolution_result).ok) ||
    !persistedFindingsValid ||
    !publicationLocationsValid
  ) {
    return { ok: false, errors: ["ReviewStateV1 nested result invariant failed"] };
  }
  return { ok: true, value: state };
}
