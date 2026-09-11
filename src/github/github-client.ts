import { ReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Octokit } from "@octokit/rest";
import { setTimeout } from "node:timers/promises";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { ConfigError } from "../config/repo-config.js";
import type { AssociatedPullRequest, ChangedFile, GitHubReader } from "./preflight-reader.js";

export interface GitHubCheckRun {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  externalId: string | null;
  appId: number | null;
}
export interface GitHubCommitStatus {
  id: number;
  context: string;
  state: string;
  targetUrl: string | null;
}
export interface GitHubWorkflowJob {
  id: number;
  runId: number;
  headSha: string;
  checkRunUrl: string;
}
export interface GithubReadClient extends GitHubReader {
  downloadHeadArchive(repository: string, headSha: string): Promise<Readable>;
  getPullRequestDiff(repository: string, prNumber: number): Promise<string>;
  listCheckRuns(repository: string, headSha: string): Promise<GitHubCheckRun[]>;
  getCommitStatuses(
    repository: string,
    headSha: string,
  ): Promise<{ sha: string; statuses: GitHubCommitStatus[] }>;
  listWorkflowRuns(repository: string, headSha: string): Promise<{ id: number; headSha: string }[]>;
  listWorkflowJobs(repository: string, runId: number): Promise<GitHubWorkflowJob[]>;
  downloadJobLog(repository: string, jobId: number): Promise<string>;
}

function completePage(total: number, received: number, pageSize: number): boolean {
  if (!Number.isSafeInteger(total) || total < received || (received < total && pageSize < 100))
    throw new Error("Incomplete GitHub evidence response");
  return received === total;
}
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
export function createGitHubClient(octokit: Octokit): GithubReadClient {
  return {
    async downloadHeadArchive(repository, headSha) {
      if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("ARCHIVE_SHA_REJECTED");
      const { data } = await retryRead(() =>
        octokit.rest.repos.downloadTarballArchive({
          ...repoParams(repository),
          ref: headSha,
          request: { parseSuccessResponseBody: false },
        }),
      );
      if (!(data instanceof ReadableStream)) throw new Error("ARCHIVE_STREAM_UNAVAILABLE");
      return Readable.fromWeb(data).compose(createGunzip());
    },
    async getPullRequestDiff(repository, prNumber) {
      const { data } = await retryRead(() =>
        octokit.rest.pulls.get({
          ...repoParams(repository),
          pull_number: prNumber,
          mediaType: { format: "diff" },
        }),
      );
      if (typeof data !== "string") throw new Error("Invalid GitHub diff response");
      return data;
    },
    async listCheckRuns(repository, headSha) {
      const checks: GitHubCheckRun[] = [];
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.checks.listForRef({
            ...repoParams(repository),
            ref: headSha,
            filter: "latest",
            per_page: 100,
            page,
          }),
        );
        if (total !== undefined && total !== data.total_count)
          throw new Error("Changed GitHub evidence response");
        total = data.total_count;
        checks.push(
          ...data.check_runs.map((check) => ({
            id: check.id,
            name: check.name,
            headSha: check.head_sha,
            status: check.status,
            conclusion: check.conclusion,
            detailsUrl: check.details_url,
            externalId: check.external_id,
            appId: check.app?.id ?? null,
          })),
        );
        if (completePage(total, checks.length, data.check_runs.length)) return checks;
      }
    },
    async getCommitStatuses(repository, headSha) {
      const statuses: GitHubCommitStatus[] = [];
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.repos.getCombinedStatusForRef({
            ...repoParams(repository),
            ref: headSha,
            per_page: 100,
            page,
          }),
        );
        if (data.sha !== headSha || (total !== undefined && total !== data.total_count))
          throw new Error("Changed GitHub evidence response");
        total = data.total_count;
        statuses.push(
          ...data.statuses.map((status) => ({
            id: status.id,
            context: status.context,
            state: status.state,
            targetUrl: status.target_url,
          })),
        );
        if (completePage(total, statuses.length, data.statuses.length))
          return { sha: data.sha, statuses };
      }
    },
    async listWorkflowRuns(repository, headSha) {
      const runs: { id: number; headSha: string }[] = [];
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.actions.listWorkflowRunsForRepo({
            ...repoParams(repository),
            head_sha: headSha,
            per_page: 100,
            page,
          }),
        );
        if (total !== undefined && total !== data.total_count)
          throw new Error("Changed GitHub evidence response");
        total = data.total_count;
        runs.push(...data.workflow_runs.map((run) => ({ id: run.id, headSha: run.head_sha })));
        if (completePage(total, runs.length, data.workflow_runs.length)) return runs;
      }
    },
    async listWorkflowJobs(repository, runId) {
      const jobs: GitHubWorkflowJob[] = [];
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.actions.listJobsForWorkflowRun({
            ...repoParams(repository),
            run_id: runId,
            filter: "latest",
            per_page: 100,
            page,
          }),
        );
        if (total !== undefined && total !== data.total_count)
          throw new Error("Changed GitHub evidence response");
        total = data.total_count;
        jobs.push(
          ...data.jobs.map((job) => ({
            id: job.id,
            runId: job.run_id,
            headSha: job.head_sha,
            checkRunUrl: job.check_run_url,
          })),
        );
        if (completePage(total, jobs.length, data.jobs.length)) return jobs;
      }
    },
    async downloadJobLog(repository, jobId) {
      // The per-job endpoint redirects to plaintext; only whole-run log downloads are ZIPs.
      const { data } = await retryRead(() =>
        octokit.rest.actions.downloadJobLogsForWorkflowRun({
          ...repoParams(repository),
          job_id: jobId,
        }),
      );
      if (typeof data !== "string") throw new Error("Invalid GitHub job log response");
      return data;
    },
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
