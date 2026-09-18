import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { createGitHubClient } from "../github/github-client.js";
import type { GitHubReader } from "../github/preflight-reader.js";
import {
  runPreflight,
  validatePreflightInput,
  type PreflightInput,
} from "../orchestration/preflight-pipeline.js";

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  makeReader: (token: string) => GitHubReader = (token) =>
    createGitHubClient(new Octokit({ auth: token })),
): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: "string" },
        repository: { type: "string" },
        "triggering-run-id": { type: "string" },
        "pr-number": { type: "string" },
        "expected-head-sha": { type: "string" },
        "engine-sha": { type: "string" },
        actor: { type: "string" },
      },
    });
    const mode = values.mode;
    if (mode !== "automatic" && mode !== "manual") return 70;
    const rawId = mode === "automatic" ? values["triggering-run-id"] : values["pr-number"];
    if (
      !rawId ||
      !/^[1-9][0-9]*$/.test(rawId) ||
      (mode === "automatic" &&
        (values["pr-number"] !== undefined ||
          values["expected-head-sha"] !== undefined ||
          values.actor !== undefined)) ||
      (mode === "manual" && values["triggering-run-id"] !== undefined)
    )
      return 70;
    const common = { repository: values.repository ?? "", engineSha: values["engine-sha"] ?? "" };
    const input: PreflightInput =
      mode === "automatic"
        ? { ...common, mode, triggeringRunId: Number(rawId) }
        : {
            ...common,
            mode,
            prNumber: Number(rawId),
            actor: values.actor ?? env.GITHUB_ACTOR ?? "",
            ...(values["expected-head-sha"] === undefined
              ? {}
              : { expectedHeadSha: values["expected-head-sha"] }),
          };
    validatePreflightInput(input);
    if (!env.RUNNER_TEMP || !env.GITHUB_OUTPUT) return 70;
    const result = await runPreflight(input, makeReader(env.GITHUB_TOKEN ?? ""));
    const directory = join(env.RUNNER_TEMP, "ai-pr-review");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "preflight.json"), `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const fields = [
      "status",
      "repository",
      "pr_number",
      "base_branch",
      "base_sha",
      "head_sha",
      "linear_issue",
      "unable_reason",
    ] as const;
    const output = fields.map((field) => `${field}=${result[field] ?? ""}\n`).join("");
    await appendFile(env.GITHUB_OUTPUT, output, "utf8");
    return 0;
  } catch {
    // Never print raw GitHub errors, request headers, or PR-controlled strings.
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
