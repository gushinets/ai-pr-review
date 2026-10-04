import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleWebhook,
  type GatewayDependencies,
  type AppReviewRequest,
} from "../../src/app/gateway.js";
import { SqliteCommandLedger } from "../../src/app/command-ledger.js";

const secret = "test-webhook-secret";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const engineSha = "e".repeat(40);
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "app-ledger-"));
  const path = join(dir, "commands.sqlite");
  const ledger = new SqliteCommandLedger(path);
  cleanup.push(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const requests: AppReviewRequest[] = [];
  const deps: GatewayDependencies = {
    webhookSecret: secret,
    ledger,
    github: {
      async resolveEngine() {
        return engineSha;
      },
      async resolveTarget(repository, installationId, prNumber, actor) {
        expect([repository, installationId, prNumber, actor]).toEqual([
          "owner/repo",
          17,
          5,
          "writer",
        ]);
        return {
          repository,
          number: prNumber,
          state: "open",
          baseSha,
          headSha,
          baseBranch: "main",
        };
      },
      async dispatch(request) {
        requests.push(request);
      },
    },
  };
  const payload = {
    action: "created",
    repository: { full_name: "owner/repo" },
    installation: { id: 17 },
    issue: { number: 5, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/5" } },
    comment: { id: 71, body: "/ai-review", user: { login: "writer", type: "User" } },
    sender: { login: "untrusted-sender" },
  };
  function input(value: unknown = payload, delivery = "delivery-1", event = "issue_comment") {
    const body = Buffer.from(JSON.stringify(value));
    return {
      body,
      signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      event,
      delivery,
    };
  }
  return { deps, requests, payload, input, path };
}

describe("signed App command gateway", () => {
  it("accepts a changed engine for the same completed PR snapshot, retaining same-engine deduplication", async () => {
    const f = fixture();
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "DISPATCHED" });
    f.deps.ledger.reconcile("delivery-1", "completed");
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 72 } }, "delivery-2"),
        f.deps,
      ),
    ).toEqual({ status: "DUPLICATE_COMMAND" });
    f.deps.github.resolveEngine = async () => "f".repeat(40);
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 73 } }, "delivery-3"),
        f.deps,
      ),
    ).toEqual({ status: "DISPATCHED" });
    expect(f.requests.map(({ engineSha }) => engineSha)).toEqual(["e".repeat(40), "f".repeat(40)]);
    expect(await handleWebhook(f.input(f.payload, "replayed-delivery"), f.deps)).toEqual({
      status: "DUPLICATE_COMMENT",
    });
  });
  it.each(["", "moving-ref", "E".repeat(40)])(
    "rejects engine identity %j before claiming the command",
    async (engine) => {
      const f = fixture();
      f.deps.github.resolveEngine = async () => engine;
      expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "CENTRAL_REJECTED" });
      expect(f.deps.ledger.hasComment("owner/repo", 71)).toBe(false);
      expect(f.requests).toHaveLength(0);
    },
  );
  it("does not claim the comment when central repository verification fails", async () => {
    const f = fixture();
    f.deps.github.resolveEngine = async () => {
      throw new Error("private-token");
    };
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "CENTRAL_REJECTED" });
    expect(f.deps.ledger.hasComment("owner/repo", 71)).toBe(false);
    expect(f.requests).toHaveLength(0);
  });
  it.each(["delivery_with_underscore", "a".repeat(101)])(
    "rejects delivery %s before consuming the signed comment",
    async (delivery) => {
      const f = fixture();
      expect(await handleWebhook(f.input(f.payload, delivery), f.deps)).toEqual({
        status: "INVALID_PAYLOAD",
      });
      expect(f.deps.ledger.hasComment("owner/repo", f.payload.comment.id)).toBe(false);
      expect(f.requests).toHaveLength(0);
      expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "DISPATCHED" });
    },
  );
  it("captures GitHub base/head, uses comment author and sends one zero-config request", async () => {
    const f = fixture();
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "DISPATCHED" });
    expect(f.requests).toEqual([
      {
        schema_version: 2,
        repository: "owner/repo",
        prNumber: 5,
        baseSha,
        headSha,
        engineSha,
        baseBranch: "main",
        trigger: {
          kind: "app",
          actor: "writer",
          installationId: 17,
          commentId: 71,
          deliveryId: "delivery-1",
        },
        requirementsSource: { kind: "none" },
        graphMode: "off",
        execution: "canonical",
      },
    ]);
  });
  it.each(["", "sha1=abc", "sha256=0", `sha256=${"0".repeat(64)}`, `sha256=${"z".repeat(64)}`])(
    "rejects malformed/mismatched signature %s before any API",
    async (signature) => {
      const f = fixture();
      f.deps.github.resolveTarget = async () => {
        throw new Error("API must not run");
      };
      expect(await handleWebhook({ ...f.input(), signature }, f.deps)).toEqual({
        status: "INVALID_SIGNATURE",
      });
      expect(f.requests).toHaveLength(0);
    },
  );
  it("verifies raw bytes instead of parsed and reserialized JSON", async () => {
    const f = fixture();
    const input = f.input();
    expect(
      await handleWebhook(
        { ...input, body: Buffer.concat([input.body, Buffer.from(" ")]) },
        f.deps,
      ),
    ).toEqual({ status: "INVALID_SIGNATURE" });
  });
  it.each(["pull_request", "pull_request_review_comment", "push"])("ignores %s", async (event) => {
    const f = fixture();
    expect(await handleWebhook(f.input(f.payload, "delivery-1", event), f.deps)).toEqual({
      status: "IGNORED",
    });
    expect(f.requests).toHaveLength(0);
  });
  it.each(["edited", "deleted"])("ignores %s comments", async (action) => {
    const f = fixture();
    expect(await handleWebhook(f.input({ ...f.payload, action }), f.deps)).toEqual({
      status: "IGNORED",
    });
    expect(f.requests).toHaveLength(0);
  });
  it.each([
    " /ai-review",
    "/ai-review ",
    "/ai-review\n",
    "please /ai-review",
    "`/ai-review`",
    "\n/ai-review\n",
    "/ai-review codegraph",
    "/AI-REVIEW",
  ])("ignores nonexact command %j", async (body) => {
    const f = fixture();
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, body } }),
        f.deps,
      ),
    ).toEqual({ status: "IGNORED" });
    expect(f.requests).toHaveLength(0);
  });
  it("ignores normal issues and bot commands", async () => {
    const f = fixture();
    expect(await handleWebhook(f.input({ ...f.payload, issue: { number: 5 } }), f.deps)).toEqual({
      status: "IGNORED",
    });
    expect(
      await handleWebhook(
        f.input({
          ...f.payload,
          comment: { ...f.payload.comment, user: { login: "writer", type: "Bot" } },
        }),
        f.deps,
      ),
    ).toEqual({ status: "IGNORED" });
    expect(f.requests).toHaveLength(0);
  });
  it.each([null, [], { action: "created", comment: { body: "/ai-review" } }])(
    "rejects malformed payload %j",
    async (payload) => {
      const f = fixture();
      expect(await handleWebhook(f.input(payload), f.deps)).toEqual({ status: "INVALID_PAYLOAD" });
      expect(f.requests).toHaveLength(0);
    },
  );
  it("bounds bodies and delivery identities", async () => {
    const f = fixture();
    expect(await handleWebhook({ ...f.input(), body: Buffer.alloc(1_048_577) }, f.deps)).toEqual({
      status: "PAYLOAD_TOO_LARGE",
    });
    expect(await handleWebhook(f.input(f.payload, ""), f.deps)).toEqual({
      status: "INVALID_PAYLOAD",
    });
  });
  it("rejects signed malformed JSON without API calls", async () => {
    const f = fixture();
    const body = Buffer.from("{broken");
    expect(
      await handleWebhook(
        {
          ...f.input(),
          body,
          signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        f.deps,
      ),
    ).toEqual({ status: "INVALID_PAYLOAD" });
    expect(f.requests).toHaveLength(0);
  });
  it("does not dispatch when the durable ledger is unavailable", async () => {
    const f = fixture();
    f.deps.ledger.hasDelivery = () => {
      throw new Error("private database path");
    };
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "LEDGER_UNAVAILABLE" });
    expect(f.requests).toHaveLength(0);
  });
  it.each(["closed", "deleted"])("does not dispatch %s PR", async (state) => {
    const f = fixture();
    f.deps.github.resolveTarget = async () => ({
      repository: "owner/repo",
      number: 5,
      state,
      baseSha,
      headSha,
      baseBranch: "main",
    });
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "NOT_OPEN" });
    expect(f.requests).toHaveLength(0);
  });
  it("fails closed on API, authorization, installation and permission failures without leaking details", async () => {
    const f = fixture();
    f.deps.github.resolveTarget = async () => {
      throw new Error("private-key-and-token");
    };
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "TARGET_REJECTED" });
    expect(f.requests).toHaveLength(0);
  });
  it("rejects mismatched API repository, PR identity and malformed SHA", async () => {
    const f = fixture();
    for (const changed of [{ repository: "wrong/repo" }, { number: 6 }, { headSha: "bad" }]) {
      f.deps.github.resolveTarget = async () => ({
        repository: "owner/repo",
        number: 5,
        state: "open",
        baseSha,
        headSha,
        baseBranch: "main",
        ...changed,
      });
      expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "TARGET_REJECTED" });
    }
    expect(f.requests).toHaveLength(0);
  });
  it("persists delivery replay and same-base/head command deduplication across connections", async () => {
    const f = fixture();
    await handleWebhook(f.input(), f.deps);
    const reopened = new SqliteCommandLedger(f.path);
    cleanup.push(() => reopened.close());
    expect(await handleWebhook(f.input(), { ...f.deps, ledger: reopened })).toEqual({
      status: "DUPLICATE_DELIVERY",
    });
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 72 } }, "delivery-2"),
        { ...f.deps, ledger: reopened },
      ),
    ).toEqual({ status: "DUPLICATE_COMMAND" });
    expect(f.requests).toHaveLength(1);
  });
  it("claims before awaiting dispatch, preventing simultaneous duplicate spend", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.deps.github.dispatch = async (request) => {
      f.requests.push(request);
      await pending;
    };
    const first = handleWebhook(f.input(), f.deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 72 } }, "delivery-2"),
        f.deps,
      ),
    ).toEqual({
      status: "DUPLICATE_COMMAND",
    });
    release();
    await first;
    expect(f.requests).toHaveLength(1);
  });
  it("keeps ambiguous dispatch claimed until operator proves non-dispatch", async () => {
    const f = fixture();
    f.deps.github.dispatch = async () => {
      throw new Error("token secret");
    };
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "DISPATCH_UNCERTAIN" });
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 72 } }, "delivery-2"),
        f.deps,
      ),
    ).toEqual({
      status: "DUPLICATE_COMMAND",
    });
    f.deps.ledger.reconcile("delivery-1", "proven_not_dispatched");
    expect(await handleWebhook(f.input(), f.deps)).toEqual({ status: "DUPLICATE_DELIVERY" });
    f.deps.github.dispatch = async (request) => {
      f.requests.push(request);
    };
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 73 } }, "delivery-3"),
        f.deps,
      ),
    ).toEqual({
      status: "DISPATCHED",
    });
  });
  it("allows a new HEAD command but retains completed exact snapshots", async () => {
    const f = fixture();
    await handleWebhook(f.input(), f.deps);
    f.deps.ledger.reconcile("delivery-1", "completed");
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 72 } }, "delivery-2"),
        f.deps,
      ),
    ).toEqual({
      status: "DUPLICATE_COMMAND",
    });
    f.deps.github.resolveTarget = async () => ({
      repository: "owner/repo",
      number: 5,
      state: "open",
      baseSha,
      headSha: "c".repeat(40),
      baseBranch: "main",
    });
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 73 } }, "delivery-3"),
        f.deps,
      ),
    ).toEqual({
      status: "DISPATCHED",
    });
    expect(f.requests).toHaveLength(2);
  });
  it("rejects signed-comment replay with a different unsigned delivery header after HEAD changes", async () => {
    const f = fixture();
    await handleWebhook(f.input(), f.deps);
    const reopened = new SqliteCommandLedger(f.path);
    cleanup.push(() => reopened.close());
    f.deps.github.resolveTarget = async () => ({
      repository: "owner/repo",
      number: 5,
      state: "open",
      baseSha,
      headSha: "c".repeat(40),
      baseBranch: "main",
    });
    expect(
      await handleWebhook(f.input(f.payload, "replayed-delivery"), { ...f.deps, ledger: reopened }),
    ).toEqual({ status: "DUPLICATE_COMMENT" });
    expect(f.requests).toHaveLength(1);
    expect(
      await handleWebhook(
        f.input({ ...f.payload, comment: { ...f.payload.comment, id: 72 } }, "fresh-delivery"),
        f.deps,
      ),
    ).toEqual({ status: "DISPATCHED" });
    expect(f.requests).toHaveLength(2);
  });
  it("keeps accepted comment identities after manual retry reconciliation", async () => {
    const f = fixture();
    await handleWebhook(f.input(), f.deps);
    f.deps.ledger.reconcile("delivery-1", "proven_not_dispatched");
    expect(await handleWebhook(f.input(f.payload, "replayed-delivery"), f.deps)).toEqual({
      status: "DUPLICATE_COMMENT",
    });
    expect(f.requests).toHaveLength(1);
  });
});
