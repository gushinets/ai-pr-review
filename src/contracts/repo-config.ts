import Schema from "typebox/schema";
import { Type } from "typebox";
import { isRepositoryRelativePath, type ValidationResult } from "./common.js";

export interface RepoConfigV1 {
  version: 1;
  primary_ci_workflow: string;
  policy: {
    always: string[];
    scoped: Array<{ paths: string[]; include: string[] }>;
  };
}

const ScopedPolicySchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 })),
    include: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const RepoConfigV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    primary_ci_workflow: Type.String({ minLength: 1 }),
    policy: Type.Object(
      {
        always: Type.Array(Type.String({ minLength: 1 })),
        scoped: Type.Array(ScopedPolicySchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const validator = Schema.Compile(RepoConfigV1Schema);

export function validateRepoConfig(value: unknown): ValidationResult<RepoConfigV1> {
  if (!validator.Check(value)) return { ok: false, errors: ["Invalid RepoConfigV1 schema"] };
  const config = value as RepoConfigV1;
  const paths = [
    ...config.policy.always,
    ...config.policy.scoped.flatMap((entry) => [...entry.paths, ...entry.include]),
  ];
  if (!config.primary_ci_workflow.trim() || paths.some((path) => !isRepositoryRelativePath(path))) {
    return { ok: false, errors: ["RepoConfigV1 contains invalid text or paths"] };
  }
  return { ok: true, value: config };
}
