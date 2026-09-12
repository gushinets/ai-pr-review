import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseRejudgeResult } from "../../src/review-engine/rejudge-worker.js";
import { createRejudgeEngine } from "../../src/review-engine/rejudge-engine.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const cliPath = "src/cli/promotion-smoke.ts";
const runId = "2026-09-12T01-02-03-004Z-smoke";
const temps: string[] = [];
const clean = { schema_version: 1, summary: "private-summary-canary", findings: [] };
const blocker = {
  severity: "blocking",
  confidence: "high",
  title: "Addition instead of subtraction",
  location: { path: "calculator.ts", line: 2, side: "RIGHT" },
  basis: ["code", "requirements"],
  evidence: "subtract(4, 1) returns 5",
  rationale: "The required result is 3",
  remediation: "Return a - b",
};
const blocked = { ...clean, findings: [blocker] };
async function smoke() {
  expect(existsSync(cliPath), "Task 18 promotion CLI must exist").toBe(true);
  return import("../../src/cli/promotion-smoke.js");
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "promotion-contract-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(nodeSpawn).mockImplementation(actualSpawn);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Only the external worker response is synthetic: snapshot, config, confinement,
// worker environment/protocol, adapter, parsers and verdicts remain production code.
function responses(answers: Array<string | ReturnType<typeof parseRejudgeResult>>) {
  vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", "sk-sp-synthetic-promotion");
  vi.stubEnv("QWEN_API_KEY", "synthetic-legacy");
  vi.stubEnv("ALIBABA_WORKSPACE_ID", "synthetic-workspace");
  vi.stubEnv("BAILIAN_TOKEN_PLAN_API_KEY", "synthetic-alternate");
  vi.stubEnv("GITHUB_TOKEN", "synthetic-github");
  const calls: Array<{ request: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [];
  vi.mocked(nodeSpawn).mockImplementation((...args: Parameters<typeof nodeSpawn>) => {
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toHaveLength(1);
    expect(String(args[1]?.[0]).replaceAll("\\", "/")).toMatch(
      /\/review-engine\/rejudge-worker\.js$/,
    );
    const answer = answers[calls.length];
    if (answer === undefined) throw new Error("UNEXPECTED_WORKER_RETRY");
    const response =
      typeof answer === "string" ? { schema_version: 1, ok: true, answer, run_id: runId } : answer;
    const child = actualSpawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `for await (const chunk of process.stdin) {} process.stdout.write(${JSON.stringify(JSON.stringify(response) + "\n")});`,
      ],
      args[2],
    );
    const end = child.stdin!.end.bind(child.stdin!);
    child.stdin!.end = ((data: string) => {
      calls.push({ request: JSON.parse(data), env: args[2]?.env ?? {} });
      return end(data);
    }) as typeof end;
    return child;
  });
  return calls;
}
function assertPanel(calls: ReturnType<typeof responses>, count: number) {
  expect(calls).toHaveLength(count);
  expect(calls.filter(({ request }) => request.mode === "fresh")).toHaveLength(1);
  for (const { env, request } of calls) {
    expect(env.QWEN_TOKEN_PLAN_API_KEY).toBe("sk-sp-synthetic-promotion");
    for (const name of [
      "QWEN_API_KEY",
      "BAILIAN_TOKEN_PLAN_API_KEY",
      "ALIBABA_WORKSPACE_ID",
      "GITHUB_TOKEN",
    ])
      expect(env[name]).toBeUndefined();
    expect(Object.keys(request).sort()).toEqual(
      [
        "mode",
        "output_instructions",
        "prompt",
        "review_root",
        "runtime_dir",
        "schema_version",
        ...(request.mode === "resume" ? ["resume_run_id"] : []),
      ].sort(),
    );
  }
}

it("ships tiny fixed fixture pairs with the specified subtraction requirements", async () => {
  for (const fixture of ["good", "bad"]) {
    const root = `fixtures/smoke/${fixture}`;
    expect(existsSync(root), "Task 18 fixture must exist").toBe(true);
    for (const version of ["base", "head"]) {
      const code = await readFile(`${root}/${version}/calculator.ts`, "utf8");
      expect(code.trim().split(/\r?\n/).length).toBeLessThan(20);
    }
    const head = await readFile(`${root}/head/calculator.ts`, "utf8");
    expect(head).toContain(fixture === "good" ? "return a - b;" : "return a + b;");
    expect(JSON.parse(await readFile(`${root}/requirements.json`, "utf8"))).toEqual({
      identifier: `SMOKE-${fixture.toUpperCase()}`,
      title: "Implement subtraction",
      description: "subtract(a, b) must return a - b for ordinary numeric inputs.",
      comments: [],
    });
  }
});

it("reuses production modules and has no reachable GitHub publisher", async () => {
  await smoke();
  const seen = new Set<string>();
  async function visit(path: string) {
    path = resolve(path);
    if (seen.has(path)) return;
    seen.add(path);
    const source = await readFile(path, "utf8");
    expect(source).not.toMatch(/github\/publisher|orchestration\/publish-pipeline|cli\/publish/);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+\.js)["']/g))
      await visit(resolve(dirname(path), match[1]!.replace(/\.js$/, ".ts")));
  }
  await visit(cliPath);
  const files = [...seen].map((file) => file.replaceAll("\\", "/"));
  for (const file of [
    "context/snapshot",
    "sandbox/git-diff-shim",
    "review-engine/token-plan-config",
    "sandbox/pi-confinement-contract",
    "review-engine/rejudge-engine",
    "review-engine/judge-result",
    "review-engine/verdict",
    "review-engine/resolution-result",
  ])
    expect(files.some((path) => path.endsWith(`/src/${file}.ts`))).toBe(true);
});

it.each(["--provider-url", "--workspace", "--model", "--fixture", "--help", "good"])(
  "rejects CLI argument %s before credentials or execution",
  async (argument) => {
    const cli = await smoke();
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("CREDENTIAL_ACCESS");
        },
      },
    );
    expect(await cli.runCli([argument], env)).toBe(70);
    expect(nodeSpawn).not.toHaveBeenCalled();
  },
);
it("fails closed without a Token Plan key even if alternate credentials exist", async () => {
  const cli = await smoke();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await cli.runCli([], { QWEN_API_KEY: "synthetic-legacy" })).toBe(70);
  expect(nodeSpawn).not.toHaveBeenCalled();
  expect(JSON.stringify(stdout.mock.calls)).not.toContain("synthetic-legacy");
});

it.each([
  ["good", clean, "PASS"],
  ["bad", blocked, "BLOCK"],
] as const)(
  "%s uses the production snapshot, fixed panel and strict verdict",
  async (scenario, answer, outcome) => {
    const cli = await smoke();
    const calls = responses([JSON.stringify(answer)]);
    const dir = await directory();
    const result = await cli.runScenario(scenario, dir, "c".repeat(40));
    expect(result.outcome).toBe(outcome);
    expect(result.accepted).toBe(true);
    assertPanel(calls, 1);
    const root = String(calls[0]!.request.review_root);
    const runtime = String(calls[0]!.request.runtime_dir);
    expect(dirname(root)).toBe(dirname(runtime));
    expect(await readdir(root)).toEqual(
      expect.arrayContaining(["target", "control", "diff", "requirements", "metadata", ".rejudge"]),
    );
    expect(await readFile(join(root, "target/calculator.ts"), "utf8")).toContain(
      scenario === "good" ? "return a - b;" : "return a + b;",
    );
    expect(await readFile(join(runtime, "bin/git"), "utf8")).toContain("GIT_SHIM_REJECTED");
    expect(JSON.parse(await readFile(join(root, ".rejudge/config.json"), "utf8"))).toEqual({
      reviewers: [
        "qwen-token-plan/qwen3.8-flash@medium",
        "qwen-token-plan/deepseek-v4-pro-0813@high",
        "qwen-token-plan/glm-5.2@high",
      ],
      judge: "qwen-token-plan/qwen3.8-max@xhigh",
      debugLog: false,
    });
    const evidence = cli.sanitizedEvidence(result);
    expect(Object.keys(evidence).sort()).toEqual(
      [
        "scenario",
        "fixture",
        "models",
        "outcome",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "provider_failure_category",
      ].sort(),
    );
    expect(JSON.stringify(evidence)).not.toMatch(
      /private-summary|estimated_cost|sk-sp-|transcript|run_id|accepted/,
    );
    expect(evidence.input_tokens).toBeNull();
    expect(evidence.output_tokens).toBeNull();
  },
);
it.each([
  ["good", blocked],
  ["bad", clean],
] as const)("rejects wrong %s outcome", async (scenario, answer) => {
  const cli = await smoke();
  responses([JSON.stringify(answer)]);
  expect((await cli.runScenario(scenario, await directory(), "c".repeat(40))).accepted).toBe(false);
});

it("requests invalid first judge output then uses the normal same-run repair prompt", async () => {
  const cli = await smoke();
  const calls = responses(["PROMOTION_SMOKE_INVALID_JSON", JSON.stringify(clean)]);
  const result = await cli.runScenario("repair", await directory(), "c".repeat(40));
  expect(result).toMatchObject({ outcome: "PASS", accepted: true });
  assertPanel(calls, 2);
  expect(calls[0]!.request.output_instructions).toContain("PROMOTION_SMOKE_INVALID_JSON");
  expect(calls[1]!.request).toMatchObject({
    mode: "resume",
    resume_run_id: runId,
    review_root: calls[0]!.request.review_root,
    runtime_dir: calls[0]!.request.runtime_dir,
  });
  expect(calls[1]!.request.prompt).toContain("This is a protocol repair only");
  expect(calls[1]!.request.output_instructions).toContain("JudgeResultV1");
});
it("does not accept repair evidence when the first judge response was already valid", async () => {
  const cli = await smoke();
  const calls = responses([JSON.stringify(clean)]);
  expect((await cli.runScenario("repair", await directory(), "c".repeat(40))).accepted).toBe(false);
  assertPanel(calls, 1);
});
it("second invalid judge result is UNABLE without another panel or resume", async () => {
  const cli = await smoke();
  const calls = responses(["invalid", "still invalid"]);
  expect(await cli.runScenario("repair", await directory(), "c".repeat(40))).toMatchObject({
    outcome: "UNABLE_TO_REVIEW",
    accepted: false,
  });
  assertPanel(calls, 2);
});

it.each(["resolved", "invalidated", "still_present", "uncertain", "missing", "unknown"])(
  "closure acceptance validates %s against the current run and seeded blocker",
  async (status) => {
    const cli = await smoke();
    const answer = {
      schema_version: 1,
      resolutions:
        status === "missing"
          ? []
          : [
              {
                previous_finding_id: status === "unknown" ? "unknown" : "smoke-previous-blocker",
                status: status === "unknown" ? "resolved" : status,
                confidence: "high",
                current_location: null,
                evidence: "Current HEAD subtracts",
              },
            ],
    };
    const calls = responses([JSON.stringify(clean), JSON.stringify(answer)]);
    const result = await cli.runScenario("closure", await directory(), "c".repeat(40));
    expect(result.accepted).toBe(["resolved", "invalidated"].includes(status));
    expect(result.outcome).toBe(
      ["resolved", "invalidated"].includes(status)
        ? "PASS"
        : status === "still_present"
          ? "BLOCK"
          : "UNABLE_TO_REVIEW",
    );
    assertPanel(calls, 2);
    expect(calls[0]!.request.prompt).not.toContain("smoke-previous-blocker");
    expect(calls[1]!.request).toMatchObject({
      mode: "resume",
      resume_run_id: runId,
      review_root: calls[0]!.request.review_root,
      runtime_dir: calls[0]!.request.runtime_dir,
    });
    expect(calls[1]!.request.prompt).toContain("Historical finding = untrusted evidence");
    expect(calls[1]!.request.prompt).toContain("smoke-previous-blocker");
  },
);

it.each([
  ["401 invalid_api_key", "PROVIDER_AUTH_FAILED"],
  ["429 Too Many Requests", "PROVIDER_RATE_LIMITED"],
  ["429 insufficient_quota", "PROVIDER_QUOTA_EXHAUSTED"],
  ["503 Service Unavailable", "PROVIDER_UNAVAILABLE"],
])("fails closed through the actual adapter for synthetic %s", async (detail, category) => {
  const cli = await smoke();
  const response = parseRejudgeResult(
    {
      content: [
        {
          type: "text",
          text: `rejudge failed: panel (qwen-token-plan/glm-5.2) failed: did not complete cleanly (stopReason: error): ${detail} private-body-canary`,
        },
      ],
    },
    "fresh",
  );
  const calls = responses([response]);
  const result = await cli.runScenario("good", await directory(), "c".repeat(40));
  expect(result).toMatchObject({
    outcome: "UNABLE_TO_REVIEW",
    accepted: false,
    provider_failure_category: category,
  });
  assertPanel(calls, 1);
  expect(JSON.stringify(cli.sanitizedEvidence(result))).not.toContain("private-body-canary");
});

it("keeps the production adapter's shared 20-minute deadline across resume", async () => {
  const cli = await smoke();
  const calls = responses(["invalid"]);
  const dir = await directory();
  const snapshot = await cli.prepareSmokeFixture("repair", dir, "c".repeat(40));
  const engine = createRejudgeEngine();
  const input = { ...snapshot, prompt: "fresh", outputInstructions: "strict" };
  await engine.fresh(input);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * 60 * 1000 + 1);
  await expect(engine.resume({ ...input, runId })).rejects.toMatchObject({ stage: "resume" });
  assertPanel(calls, 1);
});

it.each(["ceiling", "reasoning", "model", "routing", "credential", "headers"])(
  "rejects altered final runtime %s before invoking the engine",
  async (change) => {
    const cli = await smoke();
    const dir = await directory();
    const snapshot = await cli.prepareSmokeFixture("good", dir, "c".repeat(40));
    vi.stubEnv("AI_PR_REVIEW_ROOT", snapshot.reviewRoot);
    await expect(cli.assertPromotionRuntime(snapshot)).resolves.toBeUndefined();
    const path = join(snapshot.runtimeDir, "pi-agent/models.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    const provider = config.providers["qwen-token-plan"];
    if (change === "ceiling") provider.modelOverrides["qwen3.8-max"].maxTokens = 32768;
    if (change === "reasoning") provider.models[0].thinkingLevelMap.high = null;
    if (change === "model") provider.models[0].id = "other-model";
    if (change === "routing") provider.baseUrl = "https://example.invalid";
    if (change === "credential") provider.models[0].apiKey = "synthetic-alternate";
    if (change === "headers") provider.models[0].headers = { Authorization: "synthetic-alternate" };
    await writeFile(path, JSON.stringify(config));
    await expect(cli.assertPromotionRuntime(snapshot)).rejects.toThrow();
    expect(nodeSpawn).not.toHaveBeenCalled();
  },
);

it("loads the final panel in the actual pinned Pi runtime without auth resolution or network", async () => {
  const cli = await smoke();
  const snapshot = await cli.prepareSmokeFixture("good", await directory(), "c".repeat(40));
  const pi = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const credentials = {
    read: () => {
      throw new Error("UNEXPECTED_AUTH_READ");
    },
    list: () => {
      throw new Error("UNEXPECTED_AUTH_LIST");
    },
    modify: () => {
      throw new Error("UNEXPECTED_AUTH_WRITE");
    },
    delete: () => {
      throw new Error("UNEXPECTED_AUTH_DELETE");
    },
  };
  const runtime = await pi.ModelRuntime.create({
    credentials,
    modelsPath: join(snapshot.runtimeDir, "pi-agent/models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  expect(runtime.getError()).toBeUndefined();
  for (const [id, level, ceiling] of [
    ["qwen3.8-flash", "medium", 32768],
    ["deepseek-v4-pro-0813", "high", 32768],
    ["glm-5.2", "high", 32768],
    ["qwen3.8-max", "xhigh", 24576],
  ] as const) {
    const model = runtime.getModel("qwen-token-plan", id);
    expect(model).toMatchObject({
      provider: "qwen-token-plan",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      thinkingLevelMap: { [level]: level },
      maxTokens: ceiling,
    });
  }
  expect(nodeSpawn).not.toHaveBeenCalled();
});

it("CLI requires every scenario and removes its private runtime after synthetic success", async () => {
  const cli = await smoke();
  const calls = responses([
    JSON.stringify(clean),
    JSON.stringify(blocked),
    "invalid",
    JSON.stringify(clean),
    JSON.stringify(clean),
    JSON.stringify({
      schema_version: 1,
      resolutions: [
        {
          previous_finding_id: "smoke-previous-blocker",
          status: "resolved",
          confidence: "high",
          current_location: null,
          evidence: "Current HEAD subtracts",
        },
      ],
    }),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await cli.runCli([], { QWEN_TOKEN_PLAN_API_KEY: "sk-sp-synthetic-promotion" })).toBe(0);
  expect(calls.map(({ request }) => request.mode)).toEqual([
    "fresh",
    "fresh",
    "fresh",
    "resume",
    "fresh",
    "resume",
  ]);
  const evidence = stdout.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(evidence.map(({ scenario, outcome }) => [scenario, outcome])).toEqual([
    ["good", "PASS"],
    ["bad", "BLOCK"],
    ["repair", "PASS"],
    ["closure", "PASS"],
  ]);
  expect(JSON.stringify(evidence)).not.toMatch(
    /private-summary|synthetic-promotion|estimated_cost/,
  );
  for (const { request } of calls) expect(existsSync(String(request.review_root))).toBe(false);
});

it("CLI exits nonzero on unmet acceptance without running later scenarios", async () => {
  const cli = await smoke();
  const calls = responses([JSON.stringify(blocked)]);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await cli.runCli([], { QWEN_TOKEN_PLAN_API_KEY: "sk-sp-synthetic-promotion" })).toBe(70);
  assertPanel(calls, 1);
  expect(existsSync(String(calls[0]!.request.review_root))).toBe(false);
});

it("ships a manual-only least-privilege workflow with an isolated smoke secret", async () => {
  const path = ".github/workflows/promotion-smoke.yml";
  expect(existsSync(path), "Task 18 workflow must exist").toBe(true);
  const workflow = parse(await readFile(path, "utf8"));
  const ci = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  expect(workflow.on).toEqual({ workflow_dispatch: null });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.env).toBeUndefined();
  expect(Object.keys(workflow.jobs)).toEqual(["promotion"]);
  const job = workflow.jobs.promotion;
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job["timeout-minutes"]).toBe(60);
  expect(job.env).toBeUndefined();
  expect(job.permissions).toBeUndefined();
  const steps = job.steps as Array<{
    uses?: string;
    run?: string;
    env?: unknown;
    with?: unknown;
    if?: unknown;
    "continue-on-error"?: unknown;
  }>;
  expect(steps.filter((step) => step.uses)).toEqual(
    ci.jobs.check.steps.filter((step: { uses?: string }) => step.uses),
  );
  expect(steps.filter((step) => step.run).map((step) => step.run?.trim())).toEqual([
    "sudo apt-get update\nsudo apt-get install -y --no-install-recommends ripgrep fd-find\nrg --version\nfdfind --version",
    "npm ci",
    "npm run build",
    "npm run test:security",
    "npm run cli:promotion-smoke",
  ]);
  for (const step of steps) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.env).toEqual(
      step.run === "npm run cli:promotion-smoke"
        ? { QWEN_TOKEN_PLAN_API_KEY: "${{ secrets.QWEN_TOKEN_PLAN_API_KEY }}" }
        : undefined,
    );
  }
  expect(JSON.parse(await readFile("package.json", "utf8")).scripts["cli:promotion-smoke"]).toBe(
    "node dist/src/cli/promotion-smoke.js",
  );
});
