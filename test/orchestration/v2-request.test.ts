import { describe, expect, it } from "vitest";
import { loadRepoConfigAtBase } from "../../src/config/repo-config.js";
import { validateReviewIdentity } from "../../src/contracts/review-identity.js";
import { runPreflight } from "../../src/orchestration/preflight-pipeline.js";
import type { GitHubReader, PullRequest } from "../../src/github/preflight-reader.js";

const sha = "a".repeat(40);
const pr: PullRequest = {
  number: 1,
  repository: "o/r",
  state: "open",
  author: "external",
  title: "Fix validation",
  body: null,
  baseBranch: "main",
  baseSha: "b".repeat(40),
  headSha: sha,
  changedFiles: 0,
  additions: 0,
  deletions: 0,
};
const reader: GitHubReader = {
  getPullRequest: async () => pr,
  getPermission: async () => "write",
  readContent: async () => undefined,
  listChangedFiles: async () => [],
  getWorkflowRun: async () => {
    throw new Error("unused");
  },
  associatedPullRequests: async () => [],
};
const trigger = {
  mode: "manual",
  repository: "o/r",
  prNumber: 1,
  actor: "owner",
  engineSha: sha,
} as const;

describe("V2 zero-config requirements", () => {
  it("reviews an ordinary PR without config or Linear identity", async () => {
    const result = await runPreflight(
      { ...trigger, integration: "app", requirementsSource: { kind: "none" } },
      reader,
    );
    expect(result.status).toBe("READY");
    expect(result.review_identity).toMatchObject({ linear_issue: null, head_sha: sha });
  });
  it("preserves mandatory V1 requirements", async () => {
    expect((await runPreflight(trigger, reader)).unable_reason).toBe("PR_METADATA_INVALID");
  });
  it("accepts nullable identity but still rejects missing and invalid identifiers", () => {
    const identity = {
      repository: "o/r",
      pr_number: 1,
      base_sha: sha,
      head_sha: sha,
      engine_sha: sha,
    };
    expect(validateReviewIdentity({ ...identity, linear_issue: null }).ok).toBe(true);
    expect(validateReviewIdentity(identity).ok).toBe(false);
    expect(validateReviewIdentity({ ...identity, linear_issue: "ENG-1" }).ok).toBe(false);
  });
  it("uses empty central policy only when optional BASE config is absent", async () => {
    const calls: string[] = [];
    const config = await loadRepoConfigAtBase(
      sha,
      async (path, ref) => {
        calls.push(`${path}:${ref}`);
        return undefined;
      },
      { optional: true },
    );
    expect(config.policy).toEqual({ always: [], scoped: [] });
    expect(calls).toEqual([`.github/ai-review.yml:${sha}`]);
  });
  it("fails closed on invalid present optional config", async () => {
    await expect(
      loadRepoConfigAtBase(sha, async () => "version: 9", { optional: true }),
    ).rejects.toMatchObject({ reason: "CONFIG_INVALID" });
  });
});
