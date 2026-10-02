import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_WEBHOOK_BYTES = 1_048_576;

export interface AppReviewRequest {
  schema_version: 2;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  trigger: {
    kind: "app";
    actor: string;
    installationId: number;
    commentId: number;
    deliveryId: string;
  };
  requirementsSource: { kind: "none" };
  graphMode: "off";
  execution: "canonical";
}
export interface AppPullRequest {
  repository: string;
  number: number;
  state: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
}
export interface AppGitHubGateway {
  resolveTarget(
    repository: string,
    installationId: number,
    prNumber: number,
    actor: string,
  ): Promise<AppPullRequest>;
  dispatch(request: AppReviewRequest): Promise<void>;
}
export interface GatewayDependencies {
  webhookSecret: string;
  ledger: import("./command-ledger.js").SqliteCommandLedger;
  github: AppGitHubGateway;
}
export interface WebhookInput {
  body: Buffer;
  signature: string;
  event: string;
  delivery: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function handleWebhook(
  input: WebhookInput,
  deps: GatewayDependencies,
): Promise<{ status: string }> {
  if (input.body.length > MAX_WEBHOOK_BYTES) return { status: "PAYLOAD_TOO_LARGE" };
  if (
    !deps.webhookSecret ||
    !/^sha256=[0-9a-f]{64}$/.test(input.signature) ||
    !timingSafeEqual(
      createHmac("sha256", deps.webhookSecret).update(input.body).digest(),
      Buffer.from(input.signature.slice(7), "hex"),
    )
  )
    return { status: "INVALID_SIGNATURE" };
  if (input.event !== "issue_comment") return { status: "IGNORED" };
  if (!/^[A-Za-z0-9-]{1,100}$/.test(input.delivery)) return { status: "INVALID_PAYLOAD" };
  let payload: Record<string, unknown> | undefined;
  try {
    payload = object(JSON.parse(input.body.toString("utf8")));
  } catch {
    return { status: "INVALID_PAYLOAD" };
  }
  if (!payload) return { status: "INVALID_PAYLOAD" };
  if (payload.action !== "created") return { status: "IGNORED" };
  const issue = object(payload.issue),
    comment = object(payload.comment);
  if (!issue || !comment || typeof comment.body !== "string") return { status: "INVALID_PAYLOAD" };
  if (!object(issue.pull_request) || comment.body !== "/ai-review") return { status: "IGNORED" };
  const user = object(comment.user),
    repository = object(payload.repository)?.full_name;
  const installationId = object(payload.installation)?.id;
  if (user?.type === "Bot") return { status: "IGNORED" };
  if (
    !id(issue.number) ||
    !id(comment.id) ||
    !id(installationId) ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    user?.type !== "User" ||
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
  )
    return { status: "INVALID_PAYLOAD" };
  try {
    if (deps.ledger.hasDelivery(input.delivery)) return { status: "DUPLICATE_DELIVERY" };
    if (deps.ledger.hasComment(repository, comment.id)) return { status: "DUPLICATE_COMMENT" };
  } catch {
    return { status: "LEDGER_UNAVAILABLE" };
  }
  let pr: AppPullRequest;
  try {
    pr = await deps.github.resolveTarget(repository, installationId, issue.number, user.login);
  } catch {
    return { status: "TARGET_REJECTED" };
  }
  if (pr.state !== "open") return { status: "NOT_OPEN" };
  if (
    typeof pr.repository !== "string" ||
    pr.repository.toLowerCase() !== repository.toLowerCase() ||
    pr.number !== issue.number ||
    !/^[a-f0-9]{40}$/i.test(pr.baseSha) ||
    !/^[a-f0-9]{40}$/i.test(pr.headSha) ||
    typeof pr.baseBranch !== "string" ||
    !pr.baseBranch
  )
    return { status: "TARGET_REJECTED" };
  const request: AppReviewRequest = {
    schema_version: 2,
    repository: pr.repository,
    prNumber: pr.number,
    baseSha: pr.baseSha.toLowerCase(),
    headSha: pr.headSha.toLowerCase(),
    baseBranch: pr.baseBranch,
    trigger: {
      kind: "app",
      actor: user.login,
      installationId,
      commentId: comment.id,
      deliveryId: input.delivery,
    },
    requirementsSource: { kind: "none" },
    graphMode: "off",
    execution: "canonical",
  };
  try {
    const claim = deps.ledger.claim(input.delivery, request, comment.id);
    if (claim !== "CLAIMED") return { status: claim };
  } catch {
    return { status: "LEDGER_UNAVAILABLE" };
  }
  try {
    await deps.github.dispatch(request);
    deps.ledger.recordDispatch(input.delivery, "dispatched");
    return { status: "DISPATCHED" };
  } catch {
    // A failed HTTP response or local persistence may follow an accepted run.
    // Keep the claim even if writing the uncertain marker also fails.
    try {
      deps.ledger.recordDispatch(input.delivery, "uncertain");
    } catch {
      /* claim remains */
    }
    return { status: "DISPATCH_UNCERTAIN" };
  }
}
