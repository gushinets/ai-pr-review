import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { createGitHubClient, retryRead } from "../../src/github/github-client.js";
import {
  resolvePullRequest,
  type GitHubReader,
  type PullRequest,
} from "../../src/github/preflight-reader.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const pr: PullRequest = {
  number: 7,
  state: "open",
  repository: "owner/repo",
  author: "author",
  title: "ANY-451 - Fix tests",
  body: "",
  baseBranch: "main",
  baseSha: base,
  headSha: head,
  changedFiles: 1,
  additions: 2,
  deletions: 1,
};
function fixture() {
  const calls: string[] = [];
  const reader: GitHubReader = {
    getWorkflowRun: async () => ({
      event: "pull_request",
      name: "CI",
      headSha: head,
      pullRequests: [7],
    }),
    getPullRequest: async (_repo, number) => {
      calls.push(`pr:${number}`);
      return pr;
    },
    associatedPullRequests: async () => {
      calls.push("associated");
      return [pr];
    },
    getPermission: async () => "write",
    readContent: async () => undefined,
    listChangedFiles: async () => [],
  };
  return { reader, calls };
}
const automatic = { mode: "automatic", repository: "owner/repo", triggeringRunId: 42 } as const;

describe("read-only retries", () => {
  it.each([429, 500, 502, 503, 599, "ECONNRESET", "ETIMEDOUT"])(
    "bounds transient %s at three total attempts",
    async (failure) => {
      let calls = 0;
      const delays: number[] = [];
      const error = typeof failure === "number" ? { status: failure } : { code: failure };
      await expect(
        retryRead(
          async () => {
            calls++;
            throw error;
          },
          async (ms) => {
            delays.push(ms);
          },
          () => 0,
        ),
      ).rejects.toBe(error);
      expect(calls).toBe(3);
      expect(delays).toEqual([250, 1000]);
    },
  );
  it.each([401, 403, 404, 422, 400])("does not retry HTTP %s", async (status) => {
    let calls = 0;
    await expect(
      retryRead(async () => {
        calls++;
        throw { status };
      }),
    ).rejects.toEqual({ status });
    expect(calls).toBe(1);
  });
  it("returns after recovery and does not retry arbitrary errors", async () => {
    let calls = 0;
    expect(
      await retryRead(
        async () => {
          if (++calls === 1) throw new TypeError("fetch failed");
          return 9;
        },
        async () => {},
        () => 0,
      ),
    ).toBe(9);
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      retryRead(async () => {
        calls++;
        throw new Error("bad data");
      }),
    ).rejects.toThrow("bad data");
    expect(calls).toBe(1);
  });
});

describe("PR resolution", () => {
  it("resolves the run's sole PR and checks its actual head", async () => {
    const { reader, calls } = fixture();
    expect(await resolvePullRequest(automatic, reader)).toEqual({
      status: "RESOLVED",
      pr,
      workflowName: "CI",
    });
    expect(calls).toEqual(["pr:7"]);
  });
  it("falls back to exactly one open associated PR in the caller repository", async () => {
    const { reader, calls } = fixture();
    reader.getWorkflowRun = async () => ({
      event: "pull_request",
      name: "CI",
      headSha: head,
      pullRequests: [],
    });
    reader.associatedPullRequests = async () => [
      { ...pr, state: "closed" },
      { ...pr, repository: "other/repo" },
      pr,
    ];
    expect(await resolvePullRequest(automatic, reader)).toMatchObject({ status: "RESOLVED", pr });
    expect(calls).toEqual(["pr:7"]);
  });
  it.each(["push", "workflow_dispatch"])("skips %s without reading a PR", async (event) => {
    const { reader, calls } = fixture();
    reader.getWorkflowRun = async () => ({ event, name: "CI", headSha: head, pullRequests: [7] });
    expect(await resolvePullRequest(automatic, reader)).toEqual({
      status: "NOT_APPLICABLE_SKIPPED",
    });
    expect(calls).toEqual([]);
  });
  it("skips ambiguous run associations without guessing", async () => {
    const { reader, calls } = fixture();
    reader.getWorkflowRun = async () => ({
      event: "pull_request",
      name: "CI",
      headSha: head,
      pullRequests: [7, 8],
    });
    expect(await resolvePullRequest(automatic, reader)).toEqual({
      status: "NOT_APPLICABLE_SKIPPED",
    });
    expect(calls).toEqual([]);
    reader.getWorkflowRun = async () => ({
      event: "pull_request",
      name: "CI",
      headSha: head,
      pullRequests: [],
    });
    reader.associatedPullRequests = async () => [pr, { ...pr, number: 8 }];
    expect(await resolvePullRequest(automatic, reader)).toEqual({
      status: "NOT_APPLICABLE_SKIPPED",
    });
  });
  it("skips closed and stale PRs", async () => {
    const { reader } = fixture();
    reader.getPullRequest = async () => ({ ...pr, state: "closed" });
    expect(await resolvePullRequest(automatic, reader)).toEqual({
      status: "NOT_APPLICABLE_SKIPPED",
    });
    reader.getPullRequest = async () => ({ ...pr, headSha: "c".repeat(40) });
    expect(await resolvePullRequest(automatic, reader)).toMatchObject({ status: "STALE_SKIPPED" });
  });
  it("manual resolution never reads a workflow run", async () => {
    const { reader, calls } = fixture();
    reader.getWorkflowRun = async () => {
      throw new Error("must not read run");
    };
    expect(
      await resolvePullRequest(
        { mode: "manual", repository: "owner/repo", prNumber: 7, actor: "maintainer" },
        reader,
      ),
    ).toEqual({ status: "RESOLVED", pr, workflowName: null });
    expect(calls).toEqual(["pr:7"]);
  });
  it("skips manual resolution when the PR head moved past the requested snapshot", async () => {
    const { reader, calls } = fixture();
    expect(
      await resolvePullRequest(
        {
          mode: "manual",
          repository: "owner/repo",
          prNumber: 7,
          actor: "maintainer",
          expectedHeadSha: "c".repeat(40),
        },
        reader,
      ),
    ).toEqual({ status: "STALE_SKIPPED" });
    expect(calls).toEqual(["pr:7"]);
  });
  it("treats equivalent manual head SHA casing as the same snapshot", async () => {
    const { reader, calls } = fixture();
    expect(
      await resolvePullRequest(
        {
          mode: "manual",
          repository: "owner/repo",
          prNumber: 7,
          actor: "maintainer",
          expectedHeadSha: head.toUpperCase(),
        },
        reader,
      ),
    ).toEqual({ status: "RESOLVED", pr, workflowName: null });
    expect(calls).toEqual(["pr:7"]);
  });
});

describe("Octokit adapter", () => {
  it("paginates GET file metadata, strips private fields, reads config at exact SHA", async () => {
    const urls: URL[] = [];
    const file = (n: number) => ({
      filename: `file-${n}.ts`,
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "PRIVATE",
      raw_url: "SECRET",
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      urls.push(url);
      const data = url.pathname.includes("/contents/")
        ? { type: "file", encoding: "base64", content: Buffer.from("config").toString("base64") }
        : url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, n) => file(n))
          : [file(100)];
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const reader = createGitHubClient(new Octokit({ request: { fetch } }));
    const files = await reader.listChangedFiles("owner/repo", 7);
    expect(files).toHaveLength(101);
    expect(files[100]).toEqual({
      filename: "file-100.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(await reader.readContent("owner/repo", ".github/ai-review.yml", base)).toBe("config");
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", null]);
    expect(urls[2]?.searchParams.get("ref")).toBe(base);
  });
  it.each([401, 403, 404])("only content 404 becomes missing (%s)", async (status) => {
    let requests = 0;
    const errorLogs: string[] = [];
    const fetch: typeof globalThis.fetch = async () => {
      requests++;
      return new Response(JSON.stringify({ message: "secret error" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    const reader = createGitHubClient(
      new Octokit({
        request: { fetch },
        log: {
          debug: () => {},
          info: () => {},
          warn: console.warn,
          error: (message: string) => {
            errorLogs.push(message);
          },
        },
      }),
    );
    if (status === 404)
      expect(await reader.readContent("owner/repo", ".github/ai-review.yml", base)).toBeUndefined();
    else
      await expect(
        reader.readContent("owner/repo", ".github/ai-review.yml", base),
      ).rejects.toMatchObject({ status });
    expect(requests).toBe(1);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain(
      `GET /repos/owner/repo/contents/.github%2Fai-review.yml?ref=${base} - ${status} with id UNKNOWN`,
    );
    expect(errorLogs[0]).not.toContain("secret error");
  });
});
