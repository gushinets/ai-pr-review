import Schema from "typebox/schema";
import { Type } from "typebox";
import {
  isRepositoryRelativePath,
  type DiffSide,
  type FindingBasis,
  type FindingConfidence,
  type FindingSeverity,
  type ValidationResult,
} from "./common.js";

export interface JudgeLocationV1 {
  path: string;
  line: number;
  side: DiffSide;
}

export interface JudgeFindingV1 {
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  location: JudgeLocationV1 | null;
  basis: FindingBasis[];
  evidence: string;
  rationale: string;
  remediation: string;
}

export interface JudgeResultV1 {
  schema_version: 1;
  summary: string;
  findings: JudgeFindingV1[];
}

export const JudgeLocationV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    line: Type.Integer({ minimum: 1 }),
    side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
  },
  { additionalProperties: false },
);

export const JudgeFindingV1Schema = Type.Object(
  {
    severity: Type.Union([Type.Literal("blocking"), Type.Literal("non_blocking")]),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    title: Type.String({ minLength: 1 }),
    location: Type.Union([JudgeLocationV1Schema, Type.Null()]),
    basis: Type.Array(
      Type.Union([
        Type.Literal("code"),
        Type.Literal("ci"),
        Type.Literal("requirements"),
        Type.Literal("policy"),
      ]),
      { minItems: 1 },
    ),
    evidence: Type.String({ minLength: 1 }),
    rationale: Type.String({ minLength: 1 }),
    remediation: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const JudgeResultV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    summary: Type.String({ minLength: 1 }),
    findings: Type.Array(JudgeFindingV1Schema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);

const validator = Schema.Compile(JudgeResultV1Schema);

export function validateJudgeResult(value: unknown): ValidationResult<JudgeResultV1> {
  if (!validator.Check(value)) return { ok: false, errors: ["Invalid JudgeResultV1 schema"] };
  const result = value as JudgeResultV1;
  const invalid = result.findings.some(
    (finding) =>
      (finding.severity === "blocking" && finding.confidence !== "high") ||
      [finding.title, finding.evidence, finding.rationale, finding.remediation].some(
        (text) => !text.trim(),
      ) ||
      (finding.location !== null && !isRepositoryRelativePath(finding.location.path)),
  );
  if (!result.summary.trim() || invalid) {
    return { ok: false, errors: ["JudgeResultV1 semantic invariant failed"] };
  }
  return { ok: true, value: result };
}
