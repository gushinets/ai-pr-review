import Schema from "typebox/schema";
import { Type } from "typebox";
import type { ValidationResult } from "./common.js";

export interface ReviewIdentityV1 {
  repository: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  linear_issue: string;
  engine_sha: string;
}

export interface ReviewAttemptIdentityV1 {
  repository: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  engine_sha: string;
}

const identityFields = {
  repository: Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$" }),
  pr_number: Type.Integer({ minimum: 1 }),
  base_sha: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
  head_sha: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
  engine_sha: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
};

export const ReviewAttemptIdentityV1Schema = Type.Object(identityFields, {
  additionalProperties: false,
});

export const ReviewIdentityV1Schema = Type.Object(
  { ...identityFields, linear_issue: Type.String({ pattern: "^ANY-[1-9][0-9]*$" }) },
  { additionalProperties: false },
);

const validator = Schema.Compile(ReviewIdentityV1Schema);

export function validateReviewIdentity(value: unknown): ValidationResult<ReviewIdentityV1> {
  return validator.Check(value)
    ? { ok: true, value: value as ReviewIdentityV1 }
    : { ok: false, errors: ["Invalid ReviewIdentityV1 schema"] };
}
