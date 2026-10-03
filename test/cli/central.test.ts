import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCentralCli } from "../../src/cli/central.js";
import * as appAuth from "../../src/app/github-app.js";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import type { GithubReadClient } from "../../src/github/github-client.js";
import { GRAPH_BOUNDS, prepareGraphEvidence } from "../../src/graph/prepare.js";
import type { RejudgeEngine } from "../../src/review-engine/rejudge-engine.js";
import type { StateDiscovery } from "../../src/state/github-artifact-store.js";
import { parseReviewState } from "../../src/state/review-state.js";

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
  vi.unstubAllEnvs();
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function graphFixture(mode: "off" | "codegraph", outcome: "PASS" | "BLOCK") {
  const directory = await mkdtemp(join(tmpdir(), "central-graph-"));
  temps.push(directory);
  vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", "sk-sp-test-provider");
  const request = { ...internalRequest, graphMode: mode };
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, "output"),
    ENGINE_SHA: "e".repeat(40),
    REVIEW_REQUEST: JSON.stringify(request),
  };
  const github = {
    getPullRequest: async () => ({
      repository: request.repository,
      number: request.prNumber,
      state: "open",
      baseBranch: request.baseBranch,
      baseSha: request.baseSha,
      headSha: request.headSha,
      title: "Validate input",
      body: null,
      author: "owner",
      changedFiles: 1,
      additions: 1,
      deletions: 1,
    }),
    getPermission: async () => "write",
    readContent: async () => undefined,
    listChangedFiles: async () => [
      { filename: "run.sh", status: "modified", additions: 1, deletions: 1 },
    ],
    getPullRequestDiff: async () =>
      "diff --git a/run.sh b/run.sh\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-old\n+new\n",
    listCheckRuns: async () => [],
    getCommitStatuses: async () => ({ sha: request.headSha, statuses: [] }),
    listWorkflowRuns: async () => [],
    downloadHeadArchive: async () =>
      createReadStream(new URL("../../fixtures/security/archive-inert.tar", import.meta.url)),
  } as unknown as GithubReadClient;
  let canonical: ReviewStateV1 | null = null;
  const engine = {
    fresh: vi.fn<RejudgeEngine["fresh"]>(async () => ({
      run_id: "synthetic-graph-review",
      answer: JSON.stringify({
        schema_version: 1,
        summary: "Reviewed input validation",
        findings:
          outcome === "PASS"
            ? []
            : [
                {
                  severity: "blocking",
                  confidence: "high",
                  title: "Missing input validation",
                  location: { path: "run.sh", line: 1, side: "RIGHT" },
                  basis: ["code"],
                  evidence: "Input reaches the operation unchecked",
                  rationale: "An invalid input corrupts stored records",
                  remediation: "Reject invalid input before writing",
                },
              ],
      }),
    })),
    resume: vi.fn<RejudgeEngine["resume"]>(async () => {
      throw new Error("No historical blockers");
    }),
  };
  const dependencies = {
    github,
    engine,
    loadState: async (): Promise<StateDiscovery> =>
      canonical
        ? { kind: "reuse", state: canonical }
        : { kind: "fresh", previous: null, history: [], rerunnable: null },
  };
  expect(await runCentralCli(["prepare"], env, dependencies)).toBe(0);
  expect(await readFile(env.GITHUB_OUTPUT, "utf8")).toContain("action=EXECUTE");
  const workDir = join(directory, "ai-pr-review");
  const graphRoot = join(workDir, "private/review-root/evidence/graph");
  return {
    env,
    dependencies,
    workDir,
    graphRoot,
    manifestPath: join(graphRoot, "manifest.json"),
    reuse: (state: ReviewStateV1) => {
      canonical = state;
    },
  };
}

const graphManifest = {
  schema_version: 1,
  codegraph_version: "1.6.1",
  status: "completed",
  failure_code: null,
  bounds: GRAPH_BOUNDS,
  duration_ms: 1,
  truncated: false,
  source_files: 1,
  source_bytes: 1,
};
it.each([
  ["off ignores missing manifest", "off", undefined, "off", null, "BLOCK"],
  ["off ignores malformed manifest", "off", "{", "off", null, "PASS"],
  ["off ignores completed manifest", "off", JSON.stringify(graphManifest), "off", null, "PASS"],
  [
    "off ignores persistence failure",
    "off",
    JSON.stringify({ ...graphManifest, status: "failed", failure_code: "ARTIFACT_IO" }),
    "off",
    null,
    "PASS",
  ],
  ["missing manifest", "codegraph", undefined, "failed", "ARTIFACT_IO", "PASS"],
  ["malformed manifest", "codegraph", "{", "failed", "ARTIFACT_IO", "BLOCK"],
  [
    "incomplete manifest",
    "codegraph",
    '{"status":"completed","failure_code":null}',
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "invalid status",
    "codegraph",
    JSON.stringify({ ...graphManifest, status: "unknown" }),
    "failed",
    "ARTIFACT_IO",
    "BLOCK",
  ],
  [
    "invalid failure code",
    "codegraph",
    JSON.stringify({ ...graphManifest, status: "failed", failure_code: "UNKNOWN_FAILURE" }),
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "inconsistent status",
    "codegraph",
    JSON.stringify({ ...graphManifest, failure_code: "TIMEOUT" }),
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "failed without a code",
    "codegraph",
    JSON.stringify({ ...graphManifest, status: "failed" }),
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "unexpected off status",
    "codegraph",
    JSON.stringify({ ...graphManifest, status: "off" }),
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "wrong graph version",
    "codegraph",
    JSON.stringify({ ...graphManifest, codegraph_version: "latest" }),
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "invalid duration",
    "codegraph",
    JSON.stringify({ ...graphManifest, duration_ms: -1 }),
    "failed",
    "ARTIFACT_IO",
    "PASS",
  ],
  [
    "preprocessing failure",
    "codegraph",
    JSON.stringify({ ...graphManifest, status: "failed", failure_code: "PROCESS_FAILED" }),
    "failed",
    "PROCESS_FAILED",
    "BLOCK",
  ],
  ["completed graph", "codegraph", JSON.stringify(graphManifest), "completed", null, "PASS"],
] as const)(
  "preserves canonical review and same-head reuse for %s",
  async (_label, mode, manifest, status, code, outcome) => {
    const fixture = await graphFixture(mode, outcome);
    if (manifest !== undefined) {
      await mkdir(fixture.graphRoot, { recursive: true });
      await writeFile(fixture.manifestPath, manifest);
    }
    expect(await runCentralCli(["execute"], fixture.env, fixture.dependencies)).toBe(0);
    const state = parseReviewState(
      await readFile(join(fixture.workDir, "out/ai-review-state-v1.json"), "utf8"),
    );
    expect(state.outcome).toBe(outcome);
    expect(state.unable_reason).toBeNull();
    expect(state.telemetry.graph).toEqual({ mode, status, failure_code: code });
    expect(fixture.dependencies.engine.fresh).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.engine.resume).not.toHaveBeenCalled();
    expect(await runCentralCli(["verify"], fixture.env, fixture.dependencies)).toBe(0);
    expect(
      JSON.parse(await readFile(join(fixture.workDir, "experiment/telemetry.json"), "utf8")),
    ).toMatchObject({
      graph_variant: mode,
      graph_status: status,
      graph_failure_code: code,
      outcome,
    });
    fixture.reuse(state);
    const rerun = {
      ...fixture.env,
      RUNNER_TEMP: await mkdtemp(join(tmpdir(), "central-graph-reuse-")),
    };
    temps.push(rerun.RUNNER_TEMP);
    expect(await runCentralCli(["prepare"], rerun, fixture.dependencies)).toBe(0);
    expect(
      parseReviewState(
        await readFile(join(rerun.RUNNER_TEMP, "ai-pr-review/out/ai-review-state-v1.json"), "utf8"),
      ),
    ).toEqual(state);
    expect(fixture.dependencies.engine.fresh).toHaveBeenCalledTimes(1);
  },
);

async function prepareFixtureGraph(
  fixture: Awaited<ReturnType<typeof graphFixture>>,
  exitCode = 0,
) {
  return prepareGraphEvidence(
    {
      targetRoot: join(fixture.workDir, "private/review-root/target"),
      outputRoot: fixture.graphRoot,
      changedFiles: [{ filename: "run.sh", status: "modified", additions: 1, deletions: 1 }],
    },
    {
      run: async () => ({
        exitCode,
        stderr: "",
        stdout: JSON.stringify({
          version: "1.6.1",
          truncated: false,
          symbols: [],
          edges: [],
          changed_symbol_ids: [],
          impacted_symbol_ids: [],
          file_dependants: [],
          affected_files: ["run.sh"],
          affected_tests: [],
          boundaries: [],
        }),
      }),
    },
  );
}
it("resolves graph success before a model removes the optional manifest", async () => {
  const fixture = await graphFixture("codegraph", "PASS");
  expect(await prepareFixtureGraph(fixture)).toMatchObject({
    status: "completed",
    failure_code: null,
  });
  const fresh = fixture.dependencies.engine.fresh.getMockImplementation()!;
  fixture.dependencies.engine.fresh.mockImplementation(async (input) => {
    await rm(fixture.manifestPath);
    return fresh(input);
  });
  expect(await runCentralCli(["execute"], fixture.env, fixture.dependencies)).toBe(0);
  const state = parseReviewState(
    await readFile(join(fixture.workDir, "out/ai-review-state-v1.json"), "utf8"),
  );
  expect(state.outcome).toBe("PASS");
  expect(state.telemetry.graph).toEqual({
    mode: "codegraph",
    status: "completed",
    failure_code: null,
  });
  expect(fixture.dependencies.engine.fresh).toHaveBeenCalledTimes(1);
});

it.each([
  ["unreadable manifest", "ARTIFACT_IO"],
  ["artifact write failure", "ARTIFACT_IO"],
  ["real preprocessing failure", "INPUT_LIMIT"],
  ["graph image unavailable", "UNAVAILABLE"],
] as const)("keeps a paid review after %s", async (condition, failureCode) => {
  const fixture = await graphFixture("codegraph", "PASS");
  if (condition === "unreadable manifest") {
    await mkdir(fixture.manifestPath, { recursive: true });
  } else if (condition === "artifact write failure") {
    await mkdir(fixture.graphRoot, { recursive: true });
    expect(await prepareFixtureGraph(fixture)).toMatchObject({
      status: "failed",
      failure_code: "ARTIFACT_IO",
    });
    await expect(readFile(fixture.manifestPath)).rejects.toThrow();
  } else if (condition === "graph image unavailable") {
    expect(await prepareFixtureGraph(fixture, 125)).toMatchObject({
      status: "failed",
      failure_code: "UNAVAILABLE",
    });
  } else {
    // A bounded source failure stops preprocessing before any external process is started.
    await writeFile(
      join(fixture.workDir, "private/review-root/target/large.ts"),
      "x".repeat(GRAPH_BOUNDS.file_bytes + 1),
    );
    expect(await runCentralCli(["graph"], fixture.env, fixture.dependencies)).toBe(0);
  }
  expect(await runCentralCli(["execute"], fixture.env, fixture.dependencies)).toBe(0);
  const state = parseReviewState(
    await readFile(join(fixture.workDir, "out/ai-review-state-v1.json"), "utf8"),
  );
  expect(state.outcome).toBe("PASS");
  expect(state.telemetry.graph).toEqual({
    mode: "codegraph",
    status: "failed",
    failure_code: failureCode,
  });
  expect(fixture.dependencies.engine.fresh).toHaveBeenCalledTimes(1);
  expect(await runCentralCli(["verify"], fixture.env, fixture.dependencies)).toBe(0);
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
  ["execute", "GITHUB_DISPATCH_APP_PRIVATE_KEY"],
  ["execute", "GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE"],
  ["graph", "TARGET_READ_TOKEN"],
  ["graph", "QWEN_TOKEN_PLAN_API_KEY"],
  ["graph", "GITHUB_DISPATCH_APP_PRIVATE_KEY"],
  ["graph", "GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE"],
  ["publish", "QWEN_TOKEN_PLAN_API_KEY"],
  ["publish", "LINEAR_CLIENT_SECRET"],
  ["publish", "GITHUB_DISPATCH_APP_PRIVATE_KEY"],
  ["publish", "GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE"],
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
