import { appendFile, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Schema from "typebox/schema";
import { Octokit } from "@octokit/rest";
import { UNABLE_REASONS, type UnableReason } from "../contracts/failure-reasons.js";
import {
  ReviewAttemptIdentityV1Schema,
  validateReviewIdentity,
} from "../contracts/review-identity.js";
import { createGitHubClient, retryRead } from "../github/github-client.js";
import { LinearRequirementsLoader } from "../linear/requirements-loader.js";
import type { PreflightResult } from "../orchestration/preflight-pipeline.js";
import {
  emitPreflightUnable,
  executeReview,
  prepareReview,
  type ReviewPipelineResult,
} from "../orchestration/review-pipeline.js";
import {
  assertCreatablePathContained,
  assertRealpathContained,
} from "../sandbox/path-containment.js";
import { GitHubArtifactStateStore } from "../state/github-artifact-store.js";

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const phase = args[0];
    if (!["prepare", "execute", "emit-preflight-unable"].includes(phase ?? "")) return 70;
    const options = Object.fromEntries(
      [
        "repository",
        "pr-number",
        "base-sha",
        "head-sha",
        "engine-sha",
        "work-dir",
        "state-out",
        "linear-issue",
        "unable-reason",
      ].map((key) => [key, { type: "string" as const }]),
    );
    const { values } = parseArgs({
      args: args.slice(1),
      strict: true,
      allowPositionals: false,
      options,
    });
    const attempt = {
      repository: values.repository ?? "",
      pr_number: Number(values["pr-number"]),
      base_sha: values["base-sha"] ?? "",
      head_sha: values["head-sha"] ?? "",
      engine_sha: values["engine-sha"] ?? "",
    };
    const linearIssue = values["linear-issue"];
    const identity = linearIssue === undefined ? null : { ...attempt, linear_issue: linearIssue };
    if (
      !Schema.Compile(ReviewAttemptIdentityV1Schema).Check(attempt) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(attempt.repository) ||
      !/^[1-9][0-9]*$/.test(values["pr-number"] ?? "") ||
      !Number.isSafeInteger(attempt.pr_number) ||
      Object.values(attempt).some((v) => typeof v === "string" && /[\p{Cc}\p{Cf}]/u.test(v)) ||
      (identity !== null &&
        (!validateReviewIdentity(identity).ok || /[\p{Cc}\p{Cf}]/u.test(identity.linear_issue))) ||
      (phase !== "emit-preflight-unable" &&
        (identity === null || values["unable-reason"] !== undefined)) ||
      (phase === "emit-preflight-unable" &&
        !UNABLE_REASONS.includes(values["unable-reason"] as UnableReason))
    )
      return 70;
    const forbidden = [
      "QWEN_API_KEY",
      "BAILIAN_TOKEN_PLAN_API_KEY",
      "ALIBABA_WORKSPACE_ID",
      ...(phase === "prepare"
        ? ["QWEN_TOKEN_PLAN_API_KEY"]
        : phase === "execute"
          ? ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]
          : ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "QWEN_TOKEN_PLAN_API_KEY"]),
    ];
    if (
      forbidden.some((key) => env[key] !== undefined) ||
      !env.GITHUB_TOKEN?.trim() ||
      (phase === "prepare" &&
        (!env.LINEAR_CLIENT_ID?.trim() || !env.LINEAR_CLIENT_SECRET?.trim())) ||
      (phase === "execute" && !env.QWEN_TOKEN_PLAN_API_KEY?.trim())
    )
      return 70;
    const workDir = values["work-dir"],
      stateOut = values["state-out"];
    if (
      !env.RUNNER_TEMP ||
      !workDir ||
      !stateOut ||
      !isAbsolute(workDir) ||
      !isAbsolute(stateOut) ||
      resolve(workDir) !== resolve(env.RUNNER_TEMP, "ai-pr-review") ||
      resolve(stateOut) !== join(resolve(workDir), "out/ai-review-state-v1.json")
    )
      return 70;
    await assertCreatablePathContained(env.RUNNER_TEMP, workDir);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    if ((await lstat(workDir)).isSymbolicLink()) return 70;
    await assertCreatablePathContained(workDir, stateOut);
    await mkdir(dirname(stateOut), { recursive: true, mode: 0o700 });
    if ((await lstat(dirname(stateOut))).isSymbolicLink()) return 70;
    await assertRealpathContained(workDir, dirname(stateOut));
    try {
      const stat = await lstat(stateOut);
      if (!stat.isFile() || stat.isSymbolicLink()) return 70;
      await unlink(stateOut);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
    const github = createGitHubClient(octokit);
    const pr = await github.getPullRequest(attempt.repository, attempt.pr_number);
    const action = async (value: string) => {
      if (phase === "prepare" && env.GITHUB_OUTPUT)
        await appendFile(env.GITHUB_OUTPUT, `action=${value}\n`, "utf8");
    };
    if (pr.headSha !== attempt.head_sha || pr.baseSha !== attempt.base_sha) {
      await action("STALE");
      return 20;
    }
    if (
      pr.repository.toLowerCase() !== attempt.repository.toLowerCase() ||
      pr.number !== attempt.pr_number ||
      pr.state !== "open" ||
      !pr.baseBranch ||
      /[\p{Cc}\p{Cf}]/u.test(pr.baseBranch)
    )
      return 70;
    const preflight: PreflightResult = {
      schema_version: 1,
      mode: "manual",
      status: phase === "emit-preflight-unable" ? "UNABLE_TO_REVIEW" : "READY",
      unable_reason:
        phase === "emit-preflight-unable" ? (values["unable-reason"] as UnableReason) : null,
      repository: attempt.repository,
      pr_number: attempt.pr_number,
      base_branch: pr.baseBranch,
      base_sha: attempt.base_sha,
      head_sha: attempt.head_sha,
      linear_issue: linearIssue ?? null,
      review_attempt_identity: attempt,
      review_identity: identity,
      changed_files: [],
    };
    const input = { preflight, workDir };
    const secretValues = [
      env.GITHUB_TOKEN,
      env.LINEAR_CLIENT_ID,
      env.LINEAR_CLIENT_SECRET,
      env.QWEN_TOKEN_PLAN_API_KEY,
    ].filter((v): v is string => !!v);
    const warn = (warning: string) => process.stderr.write(`${warning}\n`);
    let result: ReviewPipelineResult | { kind: "PREPARED" },
      reused = false;
    if (phase === "prepare") {
      const loader = new LinearRequirementsLoader();
      result = await prepareReview(input, {
        github,
        secretValues,
        warn,
        loadState: async (identity, baseBranch) => {
          const [owner, repo] = identity.repository.split("/") as [string, string];
          const { data } = await retryRead(() => octokit.rest.repos.get({ owner, repo }));
          const discovery = await new GitHubArtifactStateStore(octokit, {
            defaultBranch: data.default_branch,
          }).load(identity, baseBranch);
          reused = discovery.kind === "reuse";
          return discovery;
        },
        loadRequirements: (identifier) =>
          loader.load(identifier, {
            clientId: env.LINEAR_CLIENT_ID!,
            clientSecret: env.LINEAR_CLIENT_SECRET!,
          }),
      });
    } else if (phase === "execute")
      result = await executeReview(input, {
        github,
        secretValues,
        warn,
      });
    else result = await emitPreflightUnable(input, { github, secretValues });
    if (result.kind === "STALE_SKIPPED") {
      await action("STALE");
      return 20;
    }
    if (result.kind === "UNAUTHORIZED_SKIPPED") return 21;
    if (result.kind === "NOT_APPLICABLE_SKIPPED") return 0;
    if (result.kind === "PREPARED") {
      await action("EXECUTE");
      return 0;
    }
    await writeFile(stateOut, `${JSON.stringify(result.state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await action(reused ? "REUSE" : "STATE_READY");
    return 0;
  } catch {
    // Never echo private context, environment, provider bodies or raw exceptions.
    return 70;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runCli(process.argv.slice(2));
