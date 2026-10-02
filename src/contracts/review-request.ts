import Schema from "typebox/schema";
import { Type } from "typebox";

export interface ReviewRequest {
  schema_version: 2;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  trigger:
    | { kind: "app"; actor: string; installationId: number; commentId: number; deliveryId: string }
    | { kind: "internal"; actor: string };
  requirementsSource: { kind: "none" } | { kind: "linear"; identifier: string };
  graphMode: "off" | "codegraph";
  execution: "canonical" | "shadow";
  experimentId?: string;
}
const object = { additionalProperties: false } as const;
const id = Type.Integer({ minimum: 1 });
const actor = Type.String({ pattern: "^[A-Za-z0-9-]+(?:\\[bot\\])?$", maxLength: 100 });
const sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
export const ReviewRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    repository: Type.String({
      pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$",
      maxLength: 200,
    }),
    prNumber: id,
    baseSha: sha,
    headSha: sha,
    baseBranch: Type.String({ minLength: 1, maxLength: 255 }),
    trigger: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("app"),
          actor,
          installationId: id,
          commentId: id,
          deliveryId: Type.String({ pattern: "^[A-Za-z0-9-]{1,100}$" }),
        },
        object,
      ),
      Type.Object({ kind: Type.Literal("internal"), actor }, object),
    ]),
    requirementsSource: Type.Union([
      Type.Object({ kind: Type.Literal("none") }, object),
      Type.Object(
        { kind: Type.Literal("linear"), identifier: Type.String({ pattern: "^ANY-[1-9][0-9]*$" }) },
        object,
      ),
    ]),
    graphMode: Type.Union([Type.Literal("off"), Type.Literal("codegraph")]),
    execution: Type.Union([Type.Literal("canonical"), Type.Literal("shadow")]),
    experimentId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9-]{1,80}$" })),
  },
  object,
);
const validator = Schema.Compile(ReviewRequestSchema);
export function parseReviewRequest(source: string): ReviewRequest {
  try {
    if (Buffer.byteLength(source) > 16_384) throw new Error();
    const value: unknown = JSON.parse(source);
    if (!validator.Check(value)) throw new Error();
    const request = value as ReviewRequest;
    if (
      ![
        request.prNumber,
        ...(request.trigger.kind === "app"
          ? [request.trigger.installationId, request.trigger.commentId]
          : []),
      ].every(Number.isSafeInteger) ||
      /[\p{Cc}\p{Cf}]/u.test(request.baseBranch) ||
      [".", ".."].includes(request.repository.split("/")[1]!) ||
      (request.execution === "shadow" && !request.experimentId)
    )
      throw new Error();
    return request;
  } catch {
    throw new Error("INVALID_REVIEW_REQUEST");
  }
}
