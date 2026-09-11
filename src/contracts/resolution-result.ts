import Schema from "typebox/schema";
import { Type } from "typebox";
import { isRepositoryRelativePath, type ValidationResult } from "./common.js";
import { JudgeLocationV1Schema, type JudgeLocationV1 } from "./judge-result.js";

export type ResolutionStatus = "resolved" | "still_present" | "invalidated" | "uncertain";

export interface FindingResolutionV1 {
  previous_finding_id: string;
  status: ResolutionStatus;
  confidence: "high";
  current_location: JudgeLocationV1 | null;
  evidence: string;
}

export interface ResolutionResultV1 {
  schema_version: 1;
  resolutions: FindingResolutionV1[];
}

const FindingResolutionV1Schema = Type.Object(
  {
    previous_finding_id: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("resolved"),
      Type.Literal("still_present"),
      Type.Literal("invalidated"),
      Type.Literal("uncertain"),
    ]),
    confidence: Type.Literal("high"),
    current_location: Type.Union([JudgeLocationV1Schema, Type.Null()]),
    evidence: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ResolutionResultV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    resolutions: Type.Array(FindingResolutionV1Schema),
  },
  { additionalProperties: false },
);

const validator = Schema.Compile(ResolutionResultV1Schema);

export function validateResolutionResult(value: unknown): ValidationResult<ResolutionResultV1> {
  if (!validator.Check(value)) return { ok: false, errors: ["Invalid ResolutionResultV1 schema"] };
  const result = value as ResolutionResultV1;
  const invalid = result.resolutions.some(
    (resolution) =>
      !resolution.previous_finding_id.trim() ||
      !resolution.evidence.trim() ||
      (resolution.current_location !== null &&
        !isRepositoryRelativePath(resolution.current_location.path)),
  );
  return invalid
    ? { ok: false, errors: ["ResolutionResultV1 semantic invariant failed"] }
    : { ok: true, value: result };
}
