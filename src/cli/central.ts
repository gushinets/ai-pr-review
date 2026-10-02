import { appendFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { getAppIdentity, mintInstallationToken } from "../app/github-app.js";
import { parseReviewRequest, type ReviewRequest } from "../contracts/review-request.js";
import { createGitHubClient, type GithubReadClient } from "../github/github-client.js";
import { createGitHubPublisher, type GitHubPublisher } from "../github/publisher.js";
import { prepareGraphEvidence, type GraphManifest } from "../graph/prepare.js";
import { recordExperimentTelemetry } from "../graph/experiment.js";
import { LinearRequirementsLoader } from "../linear/requirements-loader.js";
import { resolveReviewRequest } from "../orchestration/request-adapter.js";
import {
  executeReview,
  prepareReview,
  type ReviewInput,
  type ReviewPipelineResult,
} from "../orchestration/review-pipeline.js";
import { runPublish } from "../orchestration/publish-pipeline.js";
import { linearRequirements, noRequirements } from "../requirements/provider.js";
import type { RejudgeEngine } from "../review-engine/rejudge-engine.js";
import {
  assertCreatablePathContained,
  assertRealpathContained,
} from "../sandbox/path-containment.js";
import { centralArtifactName, STATE_FILE_NAME } from "../state/artifact-name.js";
import { GitHubArtifactStateStore, type StateDiscovery } from "../state/github-artifact-store.js";
import { parseReviewState } from "../state/review-state.js";

type Phase =
  | "token-read"
  | "token-publish"
  | "prepare"
  | "graph"
  | "execute"
  | "verify"
  | "publish"
  | "complete";
export interface CentralDependencies {
  github?: GithubReadClient;
  loadState?: (
    identity: NonNullable<ReviewInput["preflight"]["review_identity"]>,
    branch: string,
  ) => Promise<StateDiscovery>;
  engine?: RejudgeEngine;
  publisher?: GitHubPublisher;
}
const forbiddenByPhase: Record<Phase, string[]> = {
  "token-read": [
    "QWEN_TOKEN_PLAN_API_KEY",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "TARGET_WRITE_TOKEN",
  ],
  "token-publish": [
    "QWEN_TOKEN_PLAN_API_KEY",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "STATE_READ_TOKEN",
  ],
  prepare: [
    "QWEN_TOKEN_PLAN_API_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "TARGET_WRITE_TOKEN",
  ],
  graph: [
    "QWEN_TOKEN_PLAN_API_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "TARGET_READ_TOKEN",
    "TARGET_WRITE_TOKEN",
    "STATE_READ_TOKEN",
    "GITHUB_TOKEN",
  ],
  execute: [
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "TARGET_WRITE_TOKEN",
    "STATE_READ_TOKEN",
  ],
  verify: [
    "QWEN_TOKEN_PLAN_API_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "TARGET_WRITE_TOKEN",
    "STATE_READ_TOKEN",
  ],
  publish: [
    "QWEN_TOKEN_PLAN_API_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "TARGET_READ_TOKEN",
    "STATE_READ_TOKEN",
  ],
  complete: [
    "QWEN_TOKEN_PLAN_API_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "TARGET_READ_TOKEN",
    "TARGET_WRITE_TOKEN",
    "STATE_READ_TOKEN",
  ],
};
export function centralRequest(env: NodeJS.ProcessEnv): ReviewRequest {
  const request = parseReviewRequest(env.REVIEW_REQUEST ?? "");
  if (env.COMPARE === "true") {
    request.execution = "shadow";
    request.experimentId ??= env.GITHUB_RUN_ID ?? "";
  }
  if (env.GRAPH_ARM !== undefined) {
    if (env.GRAPH_ARM !== "off" && env.GRAPH_ARM !== "codegraph")
      throw new Error("INVALID_GRAPH_ARM");
    request.graphMode = env.GRAPH_ARM;
  }
  return parseReviewRequest(JSON.stringify(request));
}
function transport(token: string | undefined): Octokit {
  if (!token?.trim()) throw new Error("CREDENTIAL_MISSING");
  return new Octokit({
    auth: token,
    request: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
async function output(env: NodeJS.ProcessEnv, key: string, value: string): Promise<void> {
  if (!env.GITHUB_OUTPUT || /[\r\n]/.test(value)) throw new Error("OUTPUT_INVALID");
  await appendFile(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
async function readOwned(root: string, name: string): Promise<string> {
  const file = await assertRealpathContained(root, join(root, name));
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw new Error("FILE_INVALID");
  return readFile(file, "utf8");
}
async function writeOwned(root: string, name: string, value: unknown): Promise<void> {
  const path = await assertCreatablePathContained(root, join(root, name));
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await assertRealpathContained(root, resolve(path, ".."));
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}
export async function runCentralCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CentralDependencies = {},
): Promise<number> {
  try {
    const phase = args[0] as Phase;
    if (
      args.length !== 1 ||
      !Object.hasOwn(forbiddenByPhase, phase) ||
      forbiddenByPhase[phase].some((key) => env[key] !== undefined) ||
      ["QWEN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY", "ALIBABA_WORKSPACE_ID"].some(
        (key) => env[key] !== undefined,
      ) ||
      env.GITHUB_WEBHOOK_SECRET !== undefined ||
      (phase !== "complete" && env.AI_REVIEW_COMPLETION_SECRET !== undefined)
    )
      return 70;
    const request = centralRequest(env);
    if (phase === "complete") {
      if (request.execution === "shadow") return 0;
      if (
        request.trigger.kind !== "app" ||
        !env.AI_REVIEW_COMPLETION_SECRET ||
        !env.AI_REVIEW_GATEWAY_URL ||
        !env.RUNNER_TEMP
      )
        return 70;
      const endpoint = new URL("/completion", env.AI_REVIEW_GATEWAY_URL);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return 70;
      let outcome = "retryable";
      if (env.CANONICAL_UPLOADED === "true" && env.PUBLICATION_SUCCEEDED === "true") {
        const state = parseReviewState(
          await readOwned(join(env.RUNNER_TEMP, "ai-pr-review"), `out/${STATE_FILE_NAME}`),
        );
        if (state.outcome === "PASS" || state.outcome === "BLOCK") outcome = "completed";
      }
      const body = JSON.stringify({
        deliveryId: request.trigger.deliveryId,
        repository: request.repository,
        prNumber: request.prNumber,
        baseSha: request.baseSha,
        headSha: request.headSha,
        outcome,
      });
      const response = await fetch(endpoint, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-ai-review-signature-256": `sha256=${createHmac("sha256", env.AI_REVIEW_COMPLETION_SECRET).update("completion-v1:").update(body).digest("hex")}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return 70;
      const reply: unknown = await response.json();
      if (
        !reply ||
        typeof reply !== "object" ||
        !("status" in reply) ||
        !["COMPLETION_RECORDED", "COMPLETION_IGNORED"].includes(String(reply.status))
      )
        return 70;
      return 0;
    }
    if (phase === "token-read" || phase === "token-publish") {
      if (request.trigger.kind !== "app") return 70;
      const credentials = {
        appId: env.GITHUB_APP_ID ?? "",
        privateKey: env.GITHUB_APP_PRIVATE_KEY ?? "",
      };
      const token = await mintInstallationToken(
        credentials,
        request.trigger.installationId,
        request.repository,
        phase === "token-read" ? "read" : "publish",
      );
      process.stdout.write(`::add-mask::${token}\n`);
      await output(env, "token", token);
      if (phase === "token-publish") {
        const app = await getAppIdentity(credentials);
        await output(env, "app_id", String(app.id));
        await output(env, "bot_login", app.botLogin);
      }
      return 0;
    }
    if (
      !env.RUNNER_TEMP ||
      !isAbsolute(env.RUNNER_TEMP) ||
      !/^[0-9a-f]{40}$/.test(env.ENGINE_SHA ?? "")
    )
      return 70;
    const workDir = join(env.RUNNER_TEMP, "ai-pr-review");
    await assertCreatablePathContained(env.RUNNER_TEMP, workDir);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    if ((await lstat(workDir)).isSymbolicLink()) return 70;
    const stateFile = `out/${STATE_FILE_NAME}`;
    const github =
      phase === "graph" || phase === "publish"
        ? undefined
        : (dependencies.github ?? createGitHubClient(transport(env.TARGET_READ_TOKEN)));
    if (phase === "prepare") {
      const input = await resolveReviewRequest(request, env.ENGINE_SHA!, workDir, github!);
      await writeOwned(workDir, "input.json", input);
      await writeOwned(workDir, "request.json", request);
      const secretValues = [
        env.TARGET_READ_TOKEN,
        env.STATE_READ_TOKEN,
        env.LINEAR_CLIENT_ID,
        env.LINEAR_CLIENT_SECRET,
      ].filter((value): value is string => !!value);
      const stateStore = dependencies.loadState
        ? null
        : new GitHubArtifactStateStore(transport(env.STATE_READ_TOKEN), {
            defaultBranch: env.STATE_DEFAULT_BRANCH ?? "",
            stateRepository: env.STATE_REPOSITORY ?? "",
          });
      const store = dependencies.loadState ?? stateStore!.load.bind(stateStore);
      const result = await prepareReview(input, {
        github: github!,
        secretValues,
        loadState: async (identity, branch) => {
          const discovery = await store(identity, branch);
          if (request.execution === "shadow" && discovery.kind === "reuse")
            return { kind: "fresh", previous: null, history: [], rerunnable: null };
          return discovery;
        },
        requirementsProvider:
          request.requirementsSource.kind === "none"
            ? noRequirements
            : linearRequirements(new LinearRequirementsLoader(), {
                clientId: env.LINEAR_CLIENT_ID ?? "",
                clientSecret: env.LINEAR_CLIENT_SECRET ?? "",
              }),
      });
      if (result.kind === "STATE_READY") await writeOwned(workDir, stateFile, result.state);
      await output(env, "action", result.kind === "PREPARED" ? "EXECUTE" : result.kind);
      return 0;
    }
    if (phase === "publish") {
      if (request.execution !== "canonical") return 70;
      const state = parseReviewState(await readOwned(workDir, stateFile));
      if (
        state.attempt_identity.repository !== request.repository ||
        state.attempt_identity.pr_number !== request.prNumber ||
        state.attempt_identity.base_sha !== request.baseSha ||
        state.attempt_identity.head_sha !== request.headSha
      )
        return 70;
      const publisher =
        dependencies.publisher ??
        createGitHubPublisher(transport(env.TARGET_WRITE_TOKEN), {
          appId: Number(env.PUBLISHER_APP_ID),
          botLogin: env.PUBLISHER_BOT_LOGIN ?? "",
        });
      const result = await runPublish(state, publisher);
      for (const warning of result.warnings) process.stderr.write(`${warning}\n`);
      await output(
        env,
        "publication_complete",
        String(result.status === "PUBLISHED" && result.warnings.length === 0),
      );
      return 0;
    }
    const input = JSON.parse(await readOwned(workDir, "input.json")) as ReviewInput;
    const saved = parseReviewRequest(await readOwned(workDir, "request.json"));
    if (
      input.workDir !== workDir ||
      input.optionalConfig !== true ||
      JSON.stringify(saved) !== JSON.stringify(request) ||
      input.preflight.review_attempt_identity?.engine_sha !== env.ENGINE_SHA
    )
      return 70;
    if (phase === "graph") {
      await prepareGraphEvidence({
        targetRoot: join(workDir, "private/review-root/target"),
        outputRoot: join(workDir, "private/review-root/evidence/graph"),
        changedFiles: input.preflight.changed_files,
        unifiedDiff: await readOwned(workDir, "private/review-root/diff/pr.diff"),
        mode: request.graphMode,
      });
      return 0;
    }
    if (phase === "execute") {
      const result: ReviewPipelineResult = await executeReview(input, {
        github: github!,
        ...(dependencies.engine ? { engine: dependencies.engine } : {}),
        secretValues: [env.TARGET_READ_TOKEN, env.QWEN_TOKEN_PLAN_API_KEY].filter(
          (value): value is string => !!value,
        ),
      });
      if (result.kind === "STATE_READY") {
        const graph = JSON.parse(
          await readOwned(workDir, "private/review-root/evidence/graph/manifest.json"),
        ) as GraphManifest;
        result.state.telemetry.graph = {
          mode: request.graphMode,
          status: graph.status,
          failure_code: graph.failure_code,
        };
        parseReviewState(JSON.stringify(result.state));
        await writeOwned(workDir, stateFile, result.state);
      }
      await output(env, "action", result.kind);
      return 0;
    }
    let state;
    try {
      state = parseReviewState(await readOwned(workDir, stateFile));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await output(env, "state_ready", "false");
      return 0;
    }
    const pr = await github!.getPullRequest(request.repository, request.prNumber);
    if (
      pr.state !== "open" ||
      pr.repository.toLowerCase() !== request.repository.toLowerCase() ||
      pr.number !== request.prNumber ||
      pr.baseSha !== request.baseSha ||
      pr.headSha !== request.headSha
    ) {
      await unlink(join(workDir, stateFile));
      await output(env, "state_ready", "false");
      return 0;
    }
    const graph = state.telemetry.graph;
    await writeOwned(
      workDir,
      "experiment/telemetry.json",
      recordExperimentTelemetry(state, graph?.mode ?? "off", {
        status: graph?.status ?? "off",
        failure_code: (graph?.failure_code ?? null) as GraphManifest["failure_code"],
      }),
    );
    const name =
      request.execution === "canonical"
        ? centralArtifactName(request.repository, request.prNumber)
        : `ai-review-experiment-v2-${request.experimentId}-${request.graphMode}-${centralArtifactName(request.repository, request.prNumber).slice("ai-review-state-v2-".length)}`;
    await output(env, "artifact_name", name);
    await output(env, "state_ready", "true");
    return 0;
  } catch {
    process.stderr.write("CENTRAL_PHASE_FAILED\n");
    return 70;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runCentralCli(process.argv.slice(2));
