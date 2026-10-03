import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteCommandLedger } from "../../src/app/command-ledger.js";
import { handleWebhook } from "../../src/app/gateway.js";
import { handleCompletion } from "../../src/app/completion.js";
import { runCentralCli, centralRequest } from "../../src/cli/central.js";
import type { ReviewRequest } from "../../src/contracts/review-request.js";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import type { GithubReadClient } from "../../src/github/github-client.js";
import type { GitHubPublisher } from "../../src/github/publisher.js";
import type { RejudgeEngine } from "../../src/review-engine/rejudge-engine.js";
import { buildWorkerEnv } from "../../src/sandbox/worker-env.js";
import { parseReviewState } from "../../src/state/review-state.js";
import type { StateDiscovery } from "../../src/state/github-artifact-store.js";

const temps: string[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          full_name: "operator/private-execution",
          private: true,
          visibility: "private",
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("fake installed App → missing graph artifact → central BLOCK → correction → closure → PASS, then shadow", async () => {
  const temp = await mkdtemp(join(tmpdir(), "app-e2e-"));
  temps.push(temp);
  const ledger = new SqliteCommandLedger(join(temp, "commands.sqlite"));
  vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", "sk-sp-test-provider");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "app-private-key-canary");
  vi.stubEnv("LINEAR_CLIENT_SECRET", "linear-secret-canary");
  const base = "b".repeat(40);
  let engineSha = "e".repeat(40),
    head = "a".repeat(40),
    canonical: ReviewStateV1 | null = null;
  const requests: ReviewRequest[] = [];
  const bad = "export function subtract(a: number, b: number) { return a + b; }\n";
  const good = bad.replace("a + b", "a - b");
  const pr = () => ({
    repository: "consumer/zero-config",
    number: 1,
    state: "open",
    baseBranch: "main",
    baseSha: base,
    headSha: head,
    title: "Correct subtraction",
    body: null,
    author: "external",
    changedFiles: 1,
    additions: 1,
    deletions: 1,
  });
  const command = async (commentId: number) => {
    const body = Buffer.from(
      JSON.stringify({
        action: "created",
        repository: { full_name: pr().repository },
        installation: { id: 7 },
        issue: { number: 1, pull_request: {} },
        comment: { id: commentId, body: "/ai-review", user: { login: "maintainer", type: "User" } },
      }),
    );
    return handleWebhook(
      {
        body,
        signature: `sha256=${createHmac("sha256", "webhook-test").update(body).digest("hex")}`,
        event: "issue_comment",
        delivery: `delivery-${commentId}`,
      },
      {
        webhookSecret: "webhook-test",
        ledger,
        github: {
          resolveTarget: async () => pr(),
          resolveEngine: async () => engineSha,
          dispatch: async (request) => {
            requests.push(request);
          },
        },
      },
    );
  };
  const github = {
    getPullRequest: async () => pr(),
    getPermission: async () => "write",
    readContent: async () => undefined,
    listChangedFiles: async () => [
      { filename: "calculator.ts", status: "modified", additions: 1, deletions: 1 },
    ],
    getPullRequestDiff: async () =>
      `diff --git a/calculator.ts b/calculator.ts\n--- a/calculator.ts\n+++ b/calculator.ts\n@@ -1 +1 @@\n-${good.trim()}\n+${(head === "a".repeat(40) ? bad : good).trim()}\n`,
    listCheckRuns: async () => [],
    getCommitStatuses: async () => ({ sha: head, statuses: [] }),
    listWorkflowRuns: async () => [],
    downloadHeadArchive: async (_repository: string, sha: string) => {
      const tar = createRequire(import.meta.url)("tar-stream") as {
        pack(): Readable & {
          entry(header: { name: string }, content: string): void;
          finalize(): void;
        };
      };
      const stream = tar.pack();
      stream.entry({ name: "snapshot/calculator.ts" }, sha === "a".repeat(40) ? bad : good);
      stream.finalize();
      return stream;
    },
  } as unknown as GithubReadClient;
  let modelCalls = 0;
  const engine: RejudgeEngine = {
    fresh: async (input) => {
      modelCalls++;
      const env = await buildWorkerEnv(input);
      expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      expect(env.LINEAR_CLIENT_SECRET).toBeUndefined();
      expect(env.TARGET_WRITE_TOKEN).toBeUndefined();
      expect(input.prompt).toContain(`base_sha=${base}`);
      expect(input.prompt).toContain(`head_sha=${head}`);
      const source = await readFile(join(input.reviewRoot, "target/calculator.ts"), "utf8");
      return {
        run_id: "synthetic-review",
        answer: JSON.stringify({
          schema_version: 1,
          summary: "Reviewed subtraction",
          findings: source.includes("a + b")
            ? [
                {
                  severity: "blocking",
                  confidence: "high",
                  title: "Subtraction adds its operands",
                  location: { path: "calculator.ts", line: 1, side: "RIGHT" },
                  basis: ["code"],
                  evidence: "The subtract function returns the sum",
                  rationale: "Callers receive an incorrect result",
                  remediation: "Subtract the second operand",
                },
              ]
            : [],
        }),
      };
    },
    resume: async (input) => ({
      run_id: input.runId,
      answer: JSON.stringify({
        schema_version: 1,
        resolutions: canonical!.findings.map((finding) => ({
          previous_finding_id: finding.finding_id,
          status: "resolved",
          confidence: "high",
          current_location: { path: "calculator.ts", line: 1, side: "RIGHT" },
          evidence: "The corrected implementation subtracts the second operand",
        })),
      }),
    }),
  };
  const checks: unknown[] = [],
    summaries: Array<{ id: number; body: string }> = [],
    inline: Array<{ id: number; body: string; original_commit_id: string }> = [];
  const publisher: GitHubPublisher = {
    getHead: async () => head,
    getCurrentIdentity: async () => ({ baseSha: base, headSha: head, state: "open" }),
    listChecks: async () => [],
    listSummaries: async () => summaries,
    listInline: async () => inline,
    writeCheck: async (_r, check) => {
      checks.push(check);
    },
    writeSummary: async (_r, _p, body, id) => {
      if (id) summaries[0]!.body = body;
      else summaries.push({ id: 1, body });
    },
    writeInline: async (_r, _p, sha, findings) => {
      for (const finding of findings)
        inline.push({ id: inline.length + 1, body: finding.body, original_commit_id: sha });
    },
  };
  const loadState = async (): Promise<StateDiscovery> =>
    canonical?.attempt_identity.head_sha === head &&
    canonical.attempt_identity.engine_sha === engineSha
      ? { kind: "reuse", state: canonical }
      : {
          kind: "fresh",
          previous: canonical,
          history: canonical ? [canonical] : [],
          rerunnable: null,
        };
  async function review(request: ReviewRequest, run: number) {
    const runner = join(temp, `run-${run}`);
    await import("node:fs/promises").then((fs) => fs.mkdir(runner));
    const output = join(runner, "output");
    await writeFile(output, "");
    const common = {
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: output,
      ENGINE_SHA: engineSha,
      EXECUTION_REPOSITORY_PRIVATE: "true",
      STATE_REPOSITORY: "operator/private-execution",
      REVIEW_REQUEST: JSON.stringify(request),
    };
    const dependencies = { github, engine, publisher, loadState };
    expect(
      await runCentralCli(
        ["prepare"],
        { ...common, TARGET_READ_TOKEN: "read-canary", STATE_READ_TOKEN: "state-canary" },
        dependencies,
      ),
    ).toBe(0);
    expect(await runCentralCli(["graph"], common, dependencies)).toBe(0);
    if (run === 1)
      await rm(join(runner, "ai-pr-review/private/review-root/evidence/graph/manifest.json"));
    expect(
      await runCentralCli(
        ["execute"],
        {
          ...common,
          TARGET_READ_TOKEN: "read-canary",
          QWEN_TOKEN_PLAN_API_KEY: "sk-sp-test-provider",
        },
        dependencies,
      ),
    ).toBe(0);
    expect(
      await runCentralCli(
        ["verify"],
        { ...common, TARGET_READ_TOKEN: "read-canary", STATE_READ_TOKEN: "state-canary" },
        dependencies,
      ),
    ).toBe(0);
    const result = parseReviewState(
      await readFile(join(runner, "ai-pr-review/out/ai-review-state-v1.json"), "utf8"),
    );
    const telemetry = JSON.parse(
      await readFile(join(runner, "ai-pr-review/experiment/telemetry.json"), "utf8"),
    );
    expect(telemetry.repository).toBe(pr().repository);
    expect(telemetry.head_sha).toBe(head);
    expect(telemetry.graph_status).toBe("off");
    expect(telemetry.graph_failure_code).toBeNull();
    expect(result.telemetry.graph).toEqual({ mode: "off", status: "off", failure_code: null });
    expect(JSON.stringify(result)).not.toContain("canary");
    if (request.execution === "canonical") {
      expect(
        await runCentralCli(
          ["publish"],
          { ...common, TARGET_WRITE_TOKEN: "publish-canary" },
          dependencies,
        ),
      ).toBe(0);
      canonical = result;
      const body = Buffer.from(
        JSON.stringify({
          deliveryId: request.trigger.kind === "app" ? request.trigger.deliveryId : "unused",
          repository: request.repository,
          prNumber: request.prNumber,
          baseSha: request.baseSha,
          headSha: request.headSha,
          engineSha: request.engineSha,
          outcome: "completed",
        }),
      );
      expect(
        await handleCompletion(
          {
            body,
            signature: `sha256=${createHmac("sha256", "completion-test").update("completion-v1:").update(body).digest("hex")}`,
          },
          { completionSecret: "completion-test", ledger },
        ),
      ).toMatchObject({ status: "COMPLETION_RECORDED" });
    } else {
      expect(
        await runCentralCli(
          ["publish"],
          { ...common, TARGET_WRITE_TOKEN: "publish-canary" },
          dependencies,
        ),
      ).toBe(70);
      expect(await readFile(output, "utf8")).toContain("artifact_name=ai-review-experiment-");
    }
    return result;
  }
  try {
    expect((await command(1)).status).toBe("DISPATCHED");
    const block = await review(requests[0]!, 1);
    expect(block.outcome).toBe("BLOCK");
    expect(inline).toHaveLength(1);
    head = "c".repeat(40);
    expect((await command(2)).status).toBe("DISPATCHED");
    const pass = await review(requests[1]!, 2);
    expect(pass.outcome).toBe("PASS");
    expect(pass.resolution_result?.resolutions[0]?.status).toBe("resolved");
    expect(pass.telemetry.closure_used).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.body).toContain("PASS");
    expect(checks).toHaveLength(2);
    expect((await command(3)).status).toBe("DUPLICATE_COMMAND");
    expect(modelCalls).toBe(2);
    engineSha = "f".repeat(40);
    expect((await command(4)).status).toBe("DISPATCHED");
    const upgraded = await review(requests[2]!, 3);
    expect(upgraded.outcome).toBe("PASS");
    expect(upgraded.attempt_identity.engine_sha).toBe(engineSha);
    expect(modelCalls).toBe(3);
    expect((await command(5)).status).toBe("DUPLICATE_COMMAND");
    await review({ ...requests[2]!, execution: "shadow", experimentId: "same-head-comparison" }, 4);
    expect(modelCalls).toBe(4);
    expect(checks).toHaveLength(3);
  } finally {
    ledger.close();
  }
});

it("comparison arms keep exact identity and remain shadows even when production state exists", () => {
  const request = {
    schema_version: 2,
    engineSha: "e".repeat(40),
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
  const env = { REVIEW_REQUEST: JSON.stringify(request), COMPARE: "true", GITHUB_RUN_ID: "42" };
  expect(centralRequest({ ...env, GRAPH_ARM: "off" })).toMatchObject({
    execution: "shadow",
    graphMode: "off",
    headSha: request.headSha,
  });
  expect(centralRequest({ ...env, GRAPH_ARM: "codegraph" })).toMatchObject({
    execution: "shadow",
    graphMode: "codegraph",
    headSha: request.headSha,
    experimentId: "42",
  });
});
