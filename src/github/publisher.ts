import type { Octokit } from "@octokit/rest";
import { retryRead } from "./github-client.js";
import type { MachineCheck } from "../publishing/summary.js";
export interface PublishedCheck {
  id: number;
  name: string;
  external_id: string | null;
  head_sha: string;
}
export interface PublishedComment {
  id: number;
  body: string;
}
export interface PublishedInline extends PublishedComment {
  original_commit_id: string;
}
export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}
export interface GitHubPublisher {
  getHead(repository: string, prNumber: number): Promise<string>;
  getCurrentIdentity?: (
    repository: string,
    prNumber: number,
  ) => Promise<{ baseSha: string; headSha: string; state: string }>;
  listChecks(repository: string, headSha: string): Promise<PublishedCheck[]>;
  listSummaries(repository: string, prNumber: number): Promise<PublishedComment[]>;
  listInline(repository: string, prNumber: number): Promise<PublishedInline[]>;
  writeCheck(repository: string, check: MachineCheck, id?: number): Promise<void>;
  writeSummary(repository: string, prNumber: number, body: string, id?: number): Promise<void>;
  writeInline(
    repository: string,
    prNumber: number,
    headSha: string,
    comments: InlineComment[],
  ): Promise<void>;
}
function repoParams(repository: string) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid repository");
  return { owner, repo };
}
function owned(user: { id: number; login: string; type: string } | null): boolean {
  // V1 uses the native github.com Actions token, never a PAT or custom App.
  return user?.id === 41898282 && user.login === "github-actions[bot]" && user.type === "Bot";
}

// Reads retry per page; writes are deliberately single-shot. The pipeline retries
// reconciliation (discovery + fresh-head barrier + write), never a blind POST.
export function createGitHubPublisher(
  octokit: Octokit,
  app?: { appId: number; botLogin: string },
): GitHubPublisher {
  if (
    app &&
    (!Number.isSafeInteger(app.appId) ||
      app.appId < 1 ||
      !/^[A-Za-z0-9-]+\[bot\]$/.test(app.botLogin))
  )
    throw new Error("Invalid publisher identity");
  const isOwned = (user: { id: number; login: string; type: string } | null) =>
    app ? user?.type === "Bot" && user.login === app.botLogin : owned(user);
  return {
    ...(app
      ? {
          async getCurrentIdentity(repository: string, prNumber: number) {
            const { data } = await retryRead(() =>
              octokit.rest.pulls.get({ ...repoParams(repository), pull_number: prNumber }),
            );
            return { baseSha: data.base.sha, headSha: data.head.sha, state: data.state };
          },
        }
      : {}),
    async getHead(repository, prNumber) {
      const { data } = await retryRead(() =>
        octokit.rest.pulls.get({ ...repoParams(repository), pull_number: prNumber }),
      );
      return data.head.sha;
    },
    async listChecks(repository, headSha) {
      const checks: PublishedCheck[] = [];
      let received = 0;
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.checks.listForRef({
            ...repoParams(repository),
            ref: headSha,
            filter: "all",
            per_page: 100,
            page,
          }),
        );
        received += data.check_runs.length;
        if (
          (total !== undefined && total !== data.total_count) ||
          !Number.isSafeInteger(data.total_count) ||
          data.total_count < received ||
          (received < data.total_count && data.check_runs.length < 100)
        )
          throw new Error("Incomplete GitHub checks response");
        total = data.total_count;
        checks.push(
          ...data.check_runs
            .filter((check) =>
              app
                ? check.app?.id === app.appId
                : check.app?.id === 15368 && check.app.slug === "github-actions",
            )
            .map((check) => ({
              id: check.id,
              name: check.name,
              external_id: check.external_id,
              head_sha: check.head_sha,
            })),
        );
        if (received === total) return checks;
      }
    },
    async listSummaries(repository, prNumber) {
      const comments: PublishedComment[] = [];
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.issues.listComments({
            ...repoParams(repository),
            issue_number: prNumber,
            per_page: 100,
            page,
          }),
        );
        comments.push(
          ...data
            .filter((comment) => isOwned(comment.user))
            .map((comment) => ({ id: comment.id, body: comment.body ?? "" })),
        );
        if (data.length < 100) return comments;
      }
    },
    async listInline(repository, prNumber) {
      const comments: PublishedInline[] = [];
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          octokit.rest.pulls.listReviewComments({
            ...repoParams(repository),
            pull_number: prNumber,
            per_page: 100,
            page,
          }),
        );
        comments.push(
          ...data
            .filter((comment) => isOwned(comment.user))
            .map((comment) => ({
              id: comment.id,
              body: comment.body,
              original_commit_id: comment.original_commit_id,
            })),
        );
        if (data.length < 100) return comments;
      }
    },
    async writeCheck(repository, check, id) {
      if (id === undefined)
        await octokit.rest.checks.create({ ...repoParams(repository), ...check });
      else {
        const { head_sha: _headSha, ...update } = check;
        await octokit.rest.checks.update({
          ...repoParams(repository),
          check_run_id: id,
          ...update,
        });
      }
    },
    async writeSummary(repository, prNumber, body, id) {
      if (id === undefined)
        await octokit.rest.issues.createComment({
          ...repoParams(repository),
          issue_number: prNumber,
          body,
        });
      else
        await octokit.rest.issues.updateComment({
          ...repoParams(repository),
          comment_id: id,
          body,
        });
    },
    async writeInline(repository, prNumber, headSha, comments) {
      await octokit.rest.pulls.createReview({
        ...repoParams(repository),
        pull_number: prNumber,
        commit_id: headSha,
        event: "COMMENT",
        body: "AI PR Review inline findings.",
        comments,
      });
    },
  };
}
