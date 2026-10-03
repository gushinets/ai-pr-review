import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWebhookServer, readGatewayConfig } from "../../src/app/server.js";
import { SqliteCommandLedger } from "../../src/app/command-ledger.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "app-http-"));
  const ledger = new SqliteCommandLedger(join(dir, "ledger.sqlite"));
  cleanup.push(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const deps = {
    webhookSecret: "secret",
    completionSecret: "completion-secret",
    ledger,
    github: {
      async resolveEngine() {
        return "e".repeat(40);
      },
      async resolveTarget() {
        throw new Error("PRIVATE-KEY-and-token");
      },
      async dispatch() {
        throw new Error("PRIVATE-KEY-and-token");
      },
    },
  };
  const server = createWebhookServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, deps };
}
const env = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_DISPATCH_APP_ID: "456",
  GITHUB_DISPATCH_APP_PRIVATE_KEY: "dispatcher-private-key",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  AI_REVIEW_COMPLETION_SECRET: "completion-secret",
  AI_REVIEW_CENTRAL_REPOSITORY: "engine/central",
  AI_REVIEW_LEDGER_PATH: "persistent/commands.sqlite",
};
describe("bounded webhook HTTP runtime", () => {
  it("exposes a health check and rejects other routes and methods", async () => {
    const f = await fixture();
    expect((await fetch(`${f.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${f.url}/unknown`)).status).toBe(404);
    expect((await fetch(`${f.url}/webhook`)).status).toBe(405);
  });
  it("rejects unsigned requests and oversized JSON bodies", async () => {
    const f = await fixture();
    const headers = {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-1",
    };
    const unsigned = await fetch(`${f.url}/webhook`, { method: "POST", headers, body: "{}" });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ status: "INVALID_SIGNATURE" });
    const oversized = await fetch(`${f.url}/webhook`, {
      method: "POST",
      headers,
      body: "x".repeat(1_048_577),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ status: "PAYLOAD_TOO_LARGE" });
  });
  it("returns fixed errors and never exception or credential details", async () => {
    const f = await fixture();
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      installation: { id: 17 },
      issue: { number: 5, pull_request: {} },
      comment: { id: 71, body: "/ai-review", user: { login: "writer", type: "User" } },
    });
    const response = await fetch(`${f.url}/webhook`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "TARGET_REJECTED" });
    expect(f.server.requestTimeout).toBeLessThanOrEqual(30_000);
    expect(f.server.headersTimeout).toBeLessThanOrEqual(10_000);
  });
  it("rejects unsupported content types", async () => {
    const f = await fixture();
    expect((await fetch(`${f.url}/webhook`, { method: "POST", body: "{}" })).status).toBe(415);
  });
  it("bounds chunked bodies without dropping the rejection response", async () => {
    const f = await fixture();
    const code = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${f.url}/webhook`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.write(Buffer.alloc(524_288));
      req.end(Buffer.alloc(524_289));
    });
    expect(code).toBe(413);
  });
  it("authenticates central completion with a separate secret and purpose", async () => {
    const f = await fixture();
    const identity = {
      repository: "owner/repo",
      prNumber: 5,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      engineSha: "e".repeat(40),
    };
    f.deps.ledger.claim("delivery-1", identity, 71);
    const body = JSON.stringify({ ...identity, deliveryId: "delivery-1", outcome: "retryable" });
    const headers = {
      "content-type": "application/json",
      "x-ai-review-signature-256": `sha256=${createHmac("sha256", "completion-secret").update("completion-v1:").update(body).digest("hex")}`,
    };
    const unsigned = await fetch(`${f.url}/completion`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.status).toBe(401);
    expect((await fetch(`${f.url}/completion`)).status).toBe(405);
    const accepted = await fetch(`${f.url}/completion`, { method: "POST", body, headers });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: "COMPLETION_RECORDED" });
    expect(f.deps.ledger.claim("delivery-2", identity, 72)).toBe("CLAIMED");
    const replay = await fetch(`${f.url}/completion`, { method: "POST", body, headers });
    expect(await replay.json()).toEqual({ status: "COMPLETION_IGNORED" });
    const oversized = await fetch(`${f.url}/completion`, {
      method: "POST",
      body: "x".repeat(4097),
      headers: { "content-type": "application/json" },
    });
    expect(oversized.status).toBe(413);
  });
});
describe("gateway deployment config", () => {
  it("uses mandatory operator identity/secrets/durable volume and configurable central workflow", () => {
    expect(readGatewayConfig(env)).toEqual({
      credentials: { appId: "123", privateKey: "private-key" },
      webhookSecret: "webhook-secret",
      completionSecret: "completion-secret",
      central: {
        repository: "engine/central",
        workflow: "central-ai-pr-review.yml",
        ref: "main",
        credentials: { appId: "456", privateKey: "dispatcher-private-key" },
      },
      ledgerPath: "persistent/commands.sqlite",
      port: 3000,
    });
    expect(
      readGatewayConfig({
        ...env,
        AI_REVIEW_CENTRAL_WORKFLOW: "custom.yml",
        AI_REVIEW_CENTRAL_REF: "release",
        PORT: "4444",
      }),
    ).toMatchObject({ central: { workflow: "custom.yml", ref: "release" }, port: 4444 });
  });
  it.each([
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_DISPATCH_APP_ID",
    "GITHUB_DISPATCH_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "AI_REVIEW_COMPLETION_SECRET",
    "AI_REVIEW_CENTRAL_REPOSITORY",
    "AI_REVIEW_LEDGER_PATH",
  ])("rejects missing %s", (name) => {
    const changed: Record<string, string> = { ...env };
    delete changed[name];
    expect(() => readGatewayConfig(changed)).toThrow("GATEWAY_CONFIG_INVALID");
  });
  it("rejects a dispatcher using the target App identity", () => {
    expect(() => readGatewayConfig({ ...env, GITHUB_DISPATCH_APP_ID: "123" })).toThrow(
      "GATEWAY_CONFIG_INVALID",
    );
  });
  it("reads the separate dispatcher key from a mounted file", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-dispatch-key-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "dispatcher.pem");
    writeFileSync(path, "mounted-dispatcher-key");
    const { GITHUB_DISPATCH_APP_PRIVATE_KEY: _inlineKey, ...fileEnv } = env;
    expect(
      readGatewayConfig({ ...fileEnv, GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE: path }).central
        .credentials,
    ).toEqual({ appId: "456", privateKey: "mounted-dispatcher-key" });
    expect(
      readGatewayConfig({ ...env, GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE: path }).central.credentials,
    ).toEqual({ appId: "456", privateKey: "dispatcher-private-key" });
    let diagnostic = "";
    try {
      readGatewayConfig({
        ...fileEnv,
        GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE: join(dir, "secret-key-path"),
      });
    } catch (error) {
      diagnostic = (error as Error).message;
    }
    expect(diagnostic).toBe("GATEWAY_CONFIG_INVALID");
  });
  it.each(["0", "65536", "not-a-port", "3000.1"])("rejects port %s", (PORT) => {
    expect(() => readGatewayConfig({ ...env, PORT })).toThrow("GATEWAY_CONFIG_INVALID");
  });
});
