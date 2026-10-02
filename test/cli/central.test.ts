import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCentralCli } from "../../src/cli/central.js";
import * as appAuth from "../../src/app/github-app.js";

const temps: string[] = [];
const internalRequest = {
  schema_version: 2,
  repository: "owner/repo",
  prNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  baseBranch: "main",
  trigger: { kind: "internal", actor: "owner" },
  requirementsSource: { kind: "none" },
  graphMode: "off",
  execution: "canonical",
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it.each(["token-read", "token-publish"])(
  "mints repository-scoped %s for a trusted internal request",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "central-internal-"));
    temps.push(directory);
    const mint = vi.spyOn(appAuth, "mintInstallationToken").mockResolvedValue("fake-read-token");
    vi.spyOn(appAuth, "getAppIdentity").mockResolvedValue({
      id: 1,
      slug: "review",
      botLogin: "review[bot]",
    });
    expect(
      await runCentralCli([phase], {
        REVIEW_REQUEST: JSON.stringify(internalRequest),
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "fake-key",
        GITHUB_OUTPUT: join(directory, "output"),
      }),
    ).toBe(0);
    expect(mint).toHaveBeenCalledWith(
      { appId: "1", privateKey: "fake-key" },
      undefined,
      "owner/repo",
      phase === "token-read" ? "read" : "publish",
    );
    expect(await readFile(join(directory, "output"), "utf8")).toContain("token=fake-read-token");
  },
);
it("internal requests require no gateway callback or completion secret", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(
    await runCentralCli(["complete"], { REVIEW_REQUEST: JSON.stringify(internalRequest) }),
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("publication failure releases a claim despite canonical upload, without discarding state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "central-complete-"));
  temps.push(directory);
  const request = {
    schema_version: 2,
    repository: "o/r",
    prNumber: 1,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    baseBranch: "main",
    trigger: {
      kind: "app",
      actor: "owner",
      installationId: 1,
      commentId: 1,
      deliveryId: "delivery-1",
    },
    requirementsSource: { kind: "none" },
    graphMode: "off",
    execution: "canonical",
  };
  const bodies: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    expect(init?.signal).toBeDefined();
    return new Response(JSON.stringify({ status: "COMPLETION_RECORDED" }), {
      headers: { "content-type": "application/json" },
    });
  });
  const env = {
    RUNNER_TEMP: directory,
    REVIEW_REQUEST: JSON.stringify(request),
    AI_REVIEW_COMPLETION_SECRET: "callback-canary",
    AI_REVIEW_GATEWAY_URL: "https://gateway.example",
    CANONICAL_UPLOADED: "true",
    PUBLICATION_SUCCEEDED: "false",
  };
  expect(await runCentralCli(["complete"], env)).toBe(0);
  expect(bodies).toEqual([
    {
      deliveryId: "delivery-1",
      repository: "o/r",
      prNumber: 1,
      baseSha: request.baseSha,
      headSha: request.headSha,
      outcome: "retryable",
    },
  ]);
});
it.each([
  ["prepare", "QWEN_TOKEN_PLAN_API_KEY"],
  ["prepare", "GITHUB_APP_PRIVATE_KEY"],
  ["execute", "GITHUB_APP_PRIVATE_KEY"],
  ["execute", "LINEAR_CLIENT_SECRET"],
  ["execute", "STATE_READ_TOKEN"],
  ["execute", "AI_REVIEW_COMPLETION_SECRET"],
  ["execute", "GITHUB_WEBHOOK_SECRET"],
  ["graph", "TARGET_READ_TOKEN"],
  ["graph", "QWEN_TOKEN_PLAN_API_KEY"],
  ["publish", "QWEN_TOKEN_PLAN_API_KEY"],
  ["publish", "LINEAR_CLIENT_SECRET"],
])("rejects %s phase credential %s before any access", async (phase, key) => {
  const directory = await mkdtemp(join(tmpdir(), "central-isolation-"));
  temps.push(directory);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(
    await runCentralCli([phase!], {
      RUNNER_TEMP: directory,
      ENGINE_SHA: "e".repeat(40),
      REVIEW_REQUEST: JSON.stringify({
        schema_version: 2,
        repository: "o/r",
        prNumber: 1,
        baseSha: "b".repeat(40),
        headSha: "a".repeat(40),
        baseBranch: "main",
        trigger: { kind: "internal", actor: "owner" },
        requirementsSource: { kind: "none" },
        graphMode: "off",
        execution: "canonical",
      }),
      [key!]: "credential-canary",
    }),
  ).toBe(70);
  expect(stderr).not.toHaveBeenCalled();
  await expect(readFile(join(directory, "ai-pr-review/input.json"))).rejects.toThrow();
});
it("rejects untrusted dispatch JSON with no output or network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "central-cli-"));
  temps.push(directory);
  expect(
    await runCentralCli(["prepare"], {
      RUNNER_TEMP: directory,
      REVIEW_REQUEST: '{"repository":"../outside"}',
    }),
  ).toBe(70);
  await expect(readFile(join(directory, "ai-pr-review/input.json"))).rejects.toThrow();
});
