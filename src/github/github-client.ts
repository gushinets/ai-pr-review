import type { Octokit } from "@octokit/rest";
import { setTimeout } from "node:timers/promises";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { ConfigError } from "../config/repo-config.js";
import type { AssociatedPullRequest, ChangedFile, GitHubReader } from "./preflight-reader.js";

function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("status" in error && typeof error.status === "number")
    return error.status === 429 || (error.status >= 500 && error.status <= 599);
  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) return true;
  return (
    "code" in error &&
    typeof error.code === "string" &&
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
      error.code,
    )
  );
}

export async function retryRead<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<unknown> = setTimeout,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2 || !isTransient(error)) throw error;
      await sleep([250, 1000][attempt]! + Math.floor(random() * 100));
    }
  }
}

function repoParams(repository: string) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid repository");
  return { owner, repo };
}

// Only explicit GET endpoints are exposed. Retry scope is a single read/page.
export function createGitHubClient(octokit: Octokit): GitHubReader {
  return {
    async getWorkflowRun(repository, runId) {
      const { data } = await retryRead(() =>
        octokit.rest.actions.getWorkflowRun({ ...repoParams(repository), run_id: runId }),
      );
      return {
        event: data.event,
        name: data.name ?? null,
        headSha: data.head_sha,
        pullRequests: (data.pull_requests ?? []).map((pr) => pr.number),
      };
    },
    async getPullRequest(repository, prNumber) {
      const { data } = await retryRead(() =>
        octokit.rest.pulls.get({ ...repoParams(repository), pull_number: prNumber }),
      );
      return {
        number: data.number,
        state: data.state,
        repository: data.base.repo.full_name,
        author: data.user.login,
        title: data.title,
        body: data.body,
        baseBranch: data.base.ref,
        baseSha: data.base.sha,
        headSha: data.head.sha,
        changedFiles: data.changed_files,
        additions: data.additions,
        deletions: data.deletions,
      };
    },
    async associatedPullRequests(repository, headSha) {
      const results: AssociatedPullRequest[] = [];
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.repos.listPullRequestsAssociatedWithCommit({
            ...repoParams(repository),
            commit_sha: headSha,
            per_page: 100,
            page,
          }),
        );
        results.push(
          ...data.map((pr) => ({
            number: pr.number,
            state: pr.state,
            repository: pr.base.repo.full_name,
          })),
        );
        if (data.length < 100) return results;
      }
    },
    async getPermission(repository, actor) {
      const { data } = await retryRead(() =>
        octokit.rest.repos.getCollaboratorPermissionLevel({
          ...repoParams(repository),
          username: actor,
        }),
      );
      return data.permission;
    },
    async readContent(repository, path, sha) {
      try {
        const { data } = await retryRead(() =>
          octokit.rest.repos.getContent({ ...repoParams(repository), path, ref: sha }),
        );
        if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64")
          throw new ConfigError("CONFIG_INVALID", "Config content is not a regular readable file");
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        )
          return undefined;
        throw error;
      }
    },
    async listChangedFiles(repository, prNumber) {
      const results: ChangedFile[] = [];
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.pulls.listFiles({
            ...repoParams(repository),
            pull_number: prNumber,
            per_page: 100,
            page,
          }),
        );
        results.push(
          ...data.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.previous_filename === undefined
              ? {}
              : { previous_filename: file.previous_filename }),
          })),
        );
        if (data.length < 100 || results.length > CENTRAL_CONFIG.maxChangedFiles) return results;
      }
    },
  };
}
