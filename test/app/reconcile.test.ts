import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteCommandLedger } from "../../src/app/command-ledger.js";
import {
  inspectCommand,
  releaseUnstartedCommand,
  runReconciliationCli,
} from "../../src/app/reconcile.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "reconcile-"));
  const ledger = new SqliteCommandLedger(join(dir, "ledger.sqlite"));
  cleanup.push(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  const identity = {
    repository: "o/r",
    prNumber: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    engineSha: "e".repeat(40),
  };
  ledger.claim("delivery-1", identity, 1);
  ledger.recordDispatch("delivery-1", "dispatched");
  return { ledger, identity, path: join(dir, "ledger.sqlite") };
}
const cancelled = { id: 1, status: "completed", conclusion: "cancelled" };
it("releases a dispatched but cancelled never-started run, retaining signed tombstones", async () => {
  const { ledger, identity } = await fixture();
  const reader = { runs: async () => [cancelled], jobs: async () => [] };
  expect(await inspectCommand(ledger, "delivery-1", reader)).toMatchObject({
    status: "PROVEN_NOT_EXECUTED",
  });
  expect(await releaseUnstartedCommand(ledger, "delivery-1", reader)).toBe("RELEASED");
  expect(ledger.claim("delivery-1", identity, 1)).toBe("DUPLICATE_DELIVERY");
  expect(ledger.claim("delivery-2", identity, 2)).toBe("CLAIMED");
});
it.each(["queued", "pending", "waiting", "requested", "in_progress"])(
  "holds a %s run",
  async (status) => {
    const { ledger, identity } = await fixture();
    const reader = {
      runs: async () => [{ ...cancelled, status, conclusion: null }],
      jobs: async () => [],
    };
    expect(await inspectCommand(ledger, "delivery-1", reader)).toMatchObject({ status: "ACTIVE" });
    await expect(releaseUnstartedCommand(ledger, "delivery-1", reader)).rejects.toThrow(
      "RECONCILIATION_NOT_PROVEN",
    );
    expect(ledger.claim("delivery-2", identity, 2)).toBe("DUPLICATE_COMMAND");
  },
);
it("no matching run is observable absence, never proof of no dispatch", async () => {
  const { ledger, identity } = await fixture();
  const reader = { runs: async () => [], jobs: async () => [] };
  expect(await inspectCommand(ledger, "delivery-1", reader)).toMatchObject({
    status: "NO_MATCHING_RUN",
  });
  await expect(releaseUnstartedCommand(ledger, "delivery-1", reader)).rejects.toThrow(
    "RECONCILIATION_NOT_PROVEN",
  );
  expect(ledger.claim("delivery-2", identity, 2)).toBe("DUPLICATE_COMMAND");
});
it.each([
  { status: "completed", conclusion: "success", jobs: [] },
  { status: "completed", conclusion: "cancelled", jobs: [{ id: 1 }] },
  { status: "unexpected", conclusion: null, jobs: [] },
])("retains executed or ambiguous evidence %#", async (value) => {
  const { ledger, identity } = await fixture();
  const reader = {
    runs: async () => [{ id: 1, status: value.status, conclusion: value.conclusion }],
    jobs: async () => value.jobs,
  };
  await expect(releaseUnstartedCommand(ledger, "delivery-1", reader)).rejects.toThrow(
    "RECONCILIATION_NOT_PROVEN",
  );
  expect(ledger.claim("delivery-2", identity, 2)).toBe("DUPLICATE_COMMAND");
});
it("rechecks evidence before release, rejecting a rerun race", async () => {
  const { ledger, identity } = await fixture();
  let calls = 0;
  const reader = {
    runs: async () => [
      ++calls === 1 ? cancelled : { ...cancelled, status: "queued", conclusion: null },
    ],
    jobs: async () => [],
  };
  await expect(releaseUnstartedCommand(ledger, "delivery-1", reader)).rejects.toThrow(
    "RECONCILIATION_NOT_PROVEN",
  );
  expect(ledger.claim("delivery-2", identity, 2)).toBe("DUPLICATE_COMMAND");
});
it("API failure remains ambiguous and completed ledger claims cannot reroll", async () => {
  const { ledger } = await fixture();
  const reader = {
    runs: async () => {
      throw new Error("private-token");
    },
    jobs: async () => [],
  };
  expect(await inspectCommand(ledger, "delivery-1", reader)).toEqual({
    status: "AMBIGUOUS",
    runIds: [],
  });
  ledger.reconcile("delivery-1", "completed");
  expect(await inspectCommand(ledger, "delivery-1", reader)).toEqual({
    status: "COMPLETED",
    runIds: [],
  });
  await expect(releaseUnstartedCommand(ledger, "delivery-1", reader)).rejects.toThrow(
    "RECONCILIATION_NOT_PROVEN",
  );
});

it.each(["canonical", "shadow", "wrong-provenance", "job-started"])(
  "CLI uses scoped central inspection and holds unsafe %s evidence",
  async (scenario) => {
    const { ledger, identity, path } = await fixture();
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const urls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      urls.push(url);
      expect(init?.signal).toBeDefined();
      let data: unknown;
      if (url.pathname.endsWith("/installation"))
        data = {
          id: 2,
          app_id: 2,
          suspended_at: null,
          permissions: { metadata: "read", actions: "write" },
        };
      else if (url.pathname.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["central"],
          permissions: { metadata: "read", actions: "read" },
        });
        data = {
          token: "inspection-token-canary",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { metadata: "read", actions: "read" },
        };
      } else if (url.pathname === "/installation/repositories")
        data = { total_count: 1, repositories: [{ id: 20, full_name: "engine/central" }] };
      else if (url.pathname === "/repos/engine/central") data = { default_branch: "main" };
      else if (url.pathname.endsWith("/runs")) {
        expect(url.searchParams.get("branch")).toBe("main");
        expect(url.searchParams.get("event")).toBe("workflow_dispatch");
        data = {
          total_count: 1,
          workflow_runs: [
            {
              id: 1,
              status: "completed",
              conclusion: "cancelled",
              repository: {
                full_name: scenario === "wrong-provenance" ? "other/repo" : "engine/central",
              },
              path: ".github/workflows/central-ai-pr-review.yml",
              head_branch: "main",
              event: "workflow_dispatch",
              display_title: `AI PR Review V2 ${scenario === "shadow" ? "shadow" : "canonical"} delivery-1`,
            },
          ],
        };
      } else if (url.pathname.endsWith("/jobs")) {
        expect(url.searchParams.get("filter")).toBe("all");
        data = {
          total_count: scenario === "job-started" ? 1 : 0,
          jobs: scenario === "job-started" ? [{ id: 7 }] : [],
        };
      } else throw new Error("unexpected endpoint");
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    });
    const env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused-target-key",
      GITHUB_DISPATCH_APP_ID: "2",
      GITHUB_DISPATCH_APP_PRIVATE_KEY: key,
      GITHUB_WEBHOOK_SECRET: "webhook",
      AI_REVIEW_COMPLETION_SECRET: "completion",
      AI_REVIEW_CENTRAL_REPOSITORY: "engine/central",
      AI_REVIEW_LEDGER_PATH: path,
      AI_REVIEW_RECONCILIATION_FROZEN: "true",
    };
    expect(await runReconciliationCli(["release", "delivery-1"], env)).toBe(
      scenario === "canonical" ? 0 : 70,
    );
    expect(ledger.claim("delivery-2", identity, 2)).toBe(
      scenario === "canonical" ? "CLAIMED" : "DUPLICATE_COMMAND",
    );
    expect(urls.every((url) => !url.pathname.includes("o/r"))).toBe(true);
    expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain(
      "inspection-token-canary",
    );
  },
);
it("release CLI requires an operator freeze before file or API access", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(await runReconciliationCli(["release", "delivery-1"], {})).toBe(70);
  expect(fetch).not.toHaveBeenCalled();
});
