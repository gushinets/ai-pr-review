import Schema from "typebox/schema";
import { Type } from "typebox";
import { isRepositoryRelativePath, type DiffSide, type ValidationResult } from "./common.js";
import { ReviewIdentityV1Schema, type ReviewIdentityV1 } from "./review-identity.js";

export type CiCheckKind = "check_run" | "commit_status";
export type CiCheckStatus =
  "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
export type CiCheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | null;

export interface CiCheckV1 {
  kind: CiCheckKind;
  name: string;
  status: CiCheckStatus;
  conclusion: CiCheckConclusion;
  details_url: string | null;
  workflow_run_id: number | null;
  job_id: number | null;
  failed_log_path: string | null;
}

export interface CiContextV1 {
  schema_version: 1;
  head_sha: string;
  primary_ci_workflow: string;
  checks: CiCheckV1[];
}

export interface DiffLocation {
  path: string;
  line: number;
  side: DiffSide;
}
export interface DiffIndex {
  contains(location: DiffLocation): boolean;
}

export interface ReviewContextV1 {
  schema_version: 1;
  review_identity: ReviewIdentityV1;
  base_branch: string;
  changed_files: string[];
  diff_stats: { files: number; additions: number; deletions: number };
  policy_paths: string[];
  requirements_path: "requirements/linear.json";
  ci: CiContextV1;
  diff_path: "diff/pr.diff";
}

const CiCheckV1Schema = Type.Object(
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
    details_url: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    workflow_run_id: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    job_id: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    failed_log_path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const CiContextV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    head_sha: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
    primary_ci_workflow: Type.String({ minLength: 1 }),
    checks: Type.Array(CiCheckV1Schema),
  },
  { additionalProperties: false },
);

export const ReviewContextV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    review_identity: ReviewIdentityV1Schema,
    base_branch: Type.String({ minLength: 1 }),
    changed_files: Type.Array(Type.String({ minLength: 1 })),
    diff_stats: Type.Object(
      {
        files: Type.Integer({ minimum: 0 }),
        additions: Type.Integer({ minimum: 0 }),
        deletions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    policy_paths: Type.Array(Type.String({ minLength: 1 })),
    requirements_path: Type.Literal("requirements/linear.json"),
    ci: CiContextV1Schema,
    diff_path: Type.Literal("diff/pr.diff"),
  },
  { additionalProperties: false },
);

const validator = Schema.Compile(ReviewContextV1Schema);

export function validateReviewContext(value: unknown): ValidationResult<ReviewContextV1> {
  if (!validator.Check(value)) return { ok: false, errors: ["Invalid ReviewContextV1 schema"] };
  const context = value as ReviewContextV1;
  const paths = [
    ...context.changed_files,
    ...context.policy_paths,
    ...context.ci.checks.flatMap((check) =>
      check.failed_log_path === null ? [] : [check.failed_log_path],
    ),
  ];
  const isSorted = (values: readonly string[]) =>
    values.every((value, index) => index === 0 || values[index - 1]! <= value);
  if (
    !context.base_branch.trim() ||
    !context.ci.primary_ci_workflow.trim() ||
    context.ci.head_sha !== context.review_identity.head_sha ||
    !isSorted(context.changed_files) ||
    !isSorted(context.policy_paths) ||
    paths.some((path) => !isRepositoryRelativePath(path))
  ) {
    return { ok: false, errors: ["ReviewContextV1 semantic invariant failed"] };
  }
  return { ok: true, value: context };
}
