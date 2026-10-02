import { createHmac, timingSafeEqual } from "node:crypto";
import type { SqliteCommandLedger } from "./command-ledger.js";
export const MAX_COMPLETION_BYTES = 4096;
export async function handleCompletion(
  input: { body: Buffer; signature: string },
  deps: { completionSecret: string; ledger: SqliteCommandLedger },
): Promise<{ status: string }> {
  if (input.body.length > MAX_COMPLETION_BYTES) return { status: "PAYLOAD_TOO_LARGE" };
  if (
    !deps.completionSecret ||
    !/^sha256=[0-9a-f]{64}$/.test(input.signature) ||
    !timingSafeEqual(
      createHmac("sha256", deps.completionSecret)
        .update("completion-v1:")
        .update(input.body)
        .digest(),
      Buffer.from(input.signature.slice(7), "hex"),
    )
  )
    return { status: "INVALID_SIGNATURE" };
  let value: unknown;
  try {
    value = JSON.parse(input.body.toString("utf8"));
  } catch {
    return { status: "INVALID_PAYLOAD" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { status: "INVALID_PAYLOAD" };
  const payload = value as Record<string, unknown>;
  const keys = ["deliveryId", "repository", "prNumber", "baseSha", "headSha", "outcome"];
  if (
    Object.keys(payload).length !== keys.length ||
    Object.keys(payload).some((key) => !keys.includes(key)) ||
    typeof payload.deliveryId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.deliveryId) ||
    typeof payload.repository !== "string" ||
    payload.repository.length > 256 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repository) ||
    typeof payload.prNumber !== "number" ||
    !Number.isSafeInteger(payload.prNumber) ||
    payload.prNumber <= 0 ||
    typeof payload.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(payload.baseSha) ||
    typeof payload.headSha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(payload.headSha) ||
    (payload.outcome !== "completed" && payload.outcome !== "retryable")
  )
    return { status: "INVALID_PAYLOAD" };
  try {
    return {
      status: deps.ledger.complete({
        deliveryId: payload.deliveryId,
        repository: payload.repository,
        prNumber: payload.prNumber,
        baseSha: payload.baseSha,
        headSha: payload.headSha,
        outcome: payload.outcome,
      }),
    };
  } catch {
    return { status: "LEDGER_UNAVAILABLE" };
  }
}
