import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCommandLedger } from "../../src/app/command-ledger.js";
import { handleCompletion } from "../../src/app/completion.js";
import { handleWebhook } from "../../src/app/gateway.js";

const identity = {
  repository: "owner/repo",
  prNumber: 5,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  engineSha: "e".repeat(40),
};
const secret = "central-completion-secret";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});
function fixture() {
  const ledger = new SqliteCommandLedger(":memory:");
  cleanup.push(() => ledger.close());
  ledger.claim("original-delivery", identity, 71);
  ledger.recordDispatch("original-delivery", "dispatched");
  const completion = {
    ...identity,
    deliveryId: "original-delivery",
    outcome: "retryable" as const,
  };
  function input(value: unknown = completion, key = secret, prefix = "completion-v1:") {
    const body = Buffer.from(JSON.stringify(value));
    return {
      body,
      signature: `sha256=${createHmac("sha256", key).update(prefix).update(body).digest("hex")}`,
    };
  }
  return { ledger, completion, input, deps: { completionSecret: secret, ledger } };
}
describe("authenticated terminal completion", () => {
  it("cannot release a changed-engine claim with a completion signed for the old engine", async () => {
    const f = fixture();
    await handleCompletion(f.input({ ...f.completion, outcome: "completed" }), f.deps);
    const changed = { ...identity, engineSha: "f".repeat(40) };
    expect(f.ledger.claim("changed-engine", changed, 72)).toBe("CLAIMED");
    expect(
      await handleCompletion(f.input({ ...f.completion, deliveryId: "changed-engine" }), f.deps),
    ).toEqual({
      status: "COMPLETION_REJECTED",
    });
    expect(f.ledger.commandStatus("changed-engine")).toBe("claimed");
    expect(await handleCompletion(f.input(), f.deps)).toEqual({ status: "COMPLETION_IGNORED" });
    expect(f.ledger.commandStatus("changed-engine")).toBe("claimed");
  });
  it("releases only a retryable command and keeps its original webhook delivery", async () => {
    const f = fixture();
    expect(await handleCompletion(f.input(), f.deps)).toEqual({ status: "COMPLETION_RECORDED" });
    expect(f.ledger.hasDelivery("original-delivery")).toBe(true);
    expect(f.ledger.claim("original-delivery", identity, 71)).toBe("DUPLICATE_DELIVERY");
    expect(f.ledger.claim("new-delivery", identity, 72)).toBe("CLAIMED");
  });
  it("an old completion replay cannot release a newer same-head command", async () => {
    const f = fixture();
    await handleCompletion(f.input(), f.deps);
    expect(f.ledger.claim("new-delivery", identity, 72)).toBe("CLAIMED");
    expect(await handleCompletion(f.input(), f.deps)).toEqual({ status: "COMPLETION_IGNORED" });
    expect(f.ledger.claim("third-delivery", identity, 73)).toBe("DUPLICATE_COMMAND");
  });
  it("retains completed PASS/BLOCK snapshots even after retryable completion replay", async () => {
    const f = fixture();
    expect(
      await handleCompletion(f.input({ ...f.completion, outcome: "completed" }), f.deps),
    ).toEqual({ status: "COMPLETION_RECORDED" });
    expect(await handleCompletion(f.input(), f.deps)).toEqual({ status: "COMPLETION_IGNORED" });
    expect(f.ledger.claim("new-delivery", identity, 72)).toBe("DUPLICATE_COMMAND");
  });
  it.each(["", "sha1=abc", `sha256=${"0".repeat(64)}`, "sha256=bad"])(
    "rejects signature %j without releasing claims",
    async (signature) => {
      const f = fixture();
      expect(await handleCompletion({ ...f.input(), signature }, f.deps)).toEqual({
        status: "INVALID_SIGNATURE",
      });
      expect(f.ledger.claim("new-delivery", identity, 72)).toBe("DUPLICATE_COMMAND");
    },
  );
  it("rejects wrong secret, webhook-purpose signature and altered raw bytes", async () => {
    const f = fixture();
    expect(await handleCompletion(f.input(f.completion, "webhook-secret"), f.deps)).toEqual({
      status: "INVALID_SIGNATURE",
    });
    expect(await handleCompletion(f.input(f.completion, secret, ""), f.deps)).toEqual({
      status: "INVALID_SIGNATURE",
    });
    const input = f.input();
    expect(
      await handleCompletion(
        { ...input, body: Buffer.concat([input.body, Buffer.from(" ")]) },
        f.deps,
      ),
    ).toEqual({ status: "INVALID_SIGNATURE" });
  });
  it.each([
    { repository: "another/repo" },
    { prNumber: 6 },
    { baseSha: "c".repeat(40) },
    { headSha: "c".repeat(40) },
    { engineSha: "f".repeat(40) },
    { deliveryId: "unknown-delivery" },
  ])("rejects mismatched claimed identity %j", async (changed) => {
    const f = fixture();
    expect(await handleCompletion(f.input({ ...f.completion, ...changed }), f.deps)).toEqual({
      status: "COMPLETION_REJECTED",
    });
    expect(f.ledger.claim("new-delivery", identity, 72)).toBe("DUPLICATE_COMMAND");
  });
  it("cannot release another claimed delivery or use a duplicate command delivery as its owner", async () => {
    const f = fixture();
    const other = { ...identity, headSha: "c".repeat(40) };
    expect(f.ledger.claim("other-delivery", other, 72)).toBe("CLAIMED");
    expect(
      await handleCompletion(f.input({ ...f.completion, deliveryId: "other-delivery" }), f.deps),
    ).toEqual({ status: "COMPLETION_REJECTED" });
    expect(f.ledger.claim("duplicate-command-delivery", identity, 73)).toBe("DUPLICATE_COMMAND");
    expect(
      await handleCompletion(
        f.input({ ...f.completion, deliveryId: "duplicate-command-delivery" }),
        f.deps,
      ),
    ).toEqual({ status: "COMPLETION_IGNORED" });
    expect(f.ledger.claim("fresh-delivery", identity, 74)).toBe("DUPLICATE_COMMAND");
  });
  it.each([
    { outcome: "PASS" },
    { outcome: "UNABLE" },
    { extra: "not-allowed" },
    { prNumber: 0 },
    { prNumber: "5" },
    { deliveryId: "" },
    { headSha: "invalid" },
    { baseSha: null },
    { engineSha: undefined },
    { engineSha: "invalid" },
    { repository: "invalid" },
  ])("rejects malformed field %j", async (changed) => {
    const f = fixture();
    expect(await handleCompletion(f.input({ ...f.completion, ...changed }), f.deps)).toEqual({
      status: "INVALID_PAYLOAD",
    });
  });
  it("rejects missing fields, arrays, malformed JSON, oversized bodies and empty completion secret", async () => {
    const f = fixture();
    expect(await handleCompletion(f.input({}), f.deps)).toEqual({ status: "INVALID_PAYLOAD" });
    expect(await handleCompletion(f.input([]), f.deps)).toEqual({ status: "INVALID_PAYLOAD" });
    const body = Buffer.from("{broken");
    expect(
      await handleCompletion(
        {
          body,
          signature: `sha256=${createHmac("sha256", secret).update("completion-v1:").update(body).digest("hex")}`,
        },
        f.deps,
      ),
    ).toEqual({ status: "INVALID_PAYLOAD" });
    expect(await handleCompletion({ ...f.input(), body: Buffer.alloc(4097) }, f.deps)).toEqual({
      status: "PAYLOAD_TOO_LARGE",
    });
    expect(await handleCompletion(f.input(), { ...f.deps, completionSecret: "" })).toEqual({
      status: "INVALID_SIGNATURE",
    });
  });
  it("retains dispatch ambiguity until an authenticated terminal callback", async () => {
    const f = fixture();
    const uncertain = { ...identity, prNumber: 6 };
    f.ledger.claim("uncertain-delivery", uncertain, 72);
    f.ledger.recordDispatch("uncertain-delivery", "uncertain");
    expect(
      await handleCompletion(
        f.input({ ...uncertain, deliveryId: "uncertain-delivery", outcome: "retryable" }),
        f.deps,
      ),
    ).toEqual({ status: "COMPLETION_RECORDED" });
    expect(f.ledger.claim("retry-delivery", uncertain, 73)).toBe("CLAIMED");
  });
  it("keeps fixed diagnostics when persistence fails", async () => {
    const f = fixture();
    f.ledger.complete = () => {
      throw new Error("private database path");
    };
    expect(await handleCompletion(f.input(), f.deps)).toEqual({ status: "LEDGER_UNAVAILABLE" });
  });
  it("accepts a new same-head /ai-review comment after retryable completion", async () => {
    const f = fixture();
    const dispatched: number[] = [];
    const payload = {
      action: "created",
      repository: { full_name: identity.repository },
      installation: { id: 17 },
      issue: { number: 5, pull_request: {} },
      comment: { id: 72, body: "/ai-review", user: { login: "writer", type: "User" } },
    };
    const webhook = () => {
      const body = Buffer.from(JSON.stringify(payload));
      return {
        body,
        signature: `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`,
        event: "issue_comment",
        delivery: "new-delivery",
      };
    };
    await handleCompletion(f.input(), f.deps);
    expect(
      await handleWebhook(webhook(), {
        webhookSecret: "webhook-secret",
        ledger: f.ledger,
        github: {
          async resolveEngine() {
            return identity.engineSha;
          },
          async resolveTarget() {
            return { ...identity, number: 5, state: "open", baseBranch: "main" };
          },
          async dispatch(request) {
            dispatched.push(request.trigger.commentId);
          },
        },
      }),
    ).toEqual({ status: "DISPATCHED" });
    expect(dispatched).toEqual([72]);
  });
});
