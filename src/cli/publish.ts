import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { createGitHubPublisher, type GitHubPublisher } from "../github/publisher.js";
import { runPublish } from "../orchestration/publish-pipeline.js";
import { parseReviewState } from "../state/review-state.js";

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  makePublisher: (token: string) => GitHubPublisher = (token) =>
    createGitHubPublisher(
      new Octokit({
        auth: token,
        // The wrapper owns diagnostics; transport logs include raw response headers.
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      }),
    ),
): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { "state-file": { type: "string" } },
    });
    if (!values["state-file"] || !env.GITHUB_TOKEN?.trim()) return 70;
    const state = parseReviewState(await readFile(values["state-file"], "utf8"));
    const result = await runPublish(state, makePublisher(env.GITHUB_TOKEN));
    for (const warning of result.warnings) console.warn(warning);
    console.log(result.status);
    return 0;
  } catch {
    // Provider errors can contain credentials, request bodies and model text.
    console.error("PUBLISH_FAILED");
    return 70;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
