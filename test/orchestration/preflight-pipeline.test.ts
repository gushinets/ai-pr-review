import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreflight } from "../../src/orchestration/preflight-pipeline.js";
import { runCli } from "../../src/cli/preflight.js";
import type { GitHubReader, PullRequest } from "../../src/github/preflight-reader.js";

const base = "b".repeat(40),
  head = "a".repeat(40),
  engine = "e".repeat(40);
const config = "version: 1\nprimary_ci_workflow: CI\npolicy:\n  always: []\n  scoped: []\n";
const attempt = {
  repository: "owner/repo",
  pr_number: 7,
  base_sha: base,
  head_sha: head,
  engine_sha: engine,
};
const input = {
  mode: "automatic",
  repository: "owner/repo",
  triggeringRunId: 42,
  engineSha: engine,
} as const;
function fixture() {
  const calls: string[] = [];
  const pr: PullRequest = {
    number: 7,
    state: "open",
    repository: "owner/repo",
    author: "author",
    title: "ANY-451 - Fix payment validation",
    body: "## Linear issue\nhttps://linear.app/paveldik/issue/ANY-451",
    baseBranch: "main",
    baseSha: base,
    headSha: head,
    changedFiles: 1,
    additions: 2,
    deletions: 1,
  };
  const reader: GitHubReader = {
    getWorkflowRun: async () => ({
      event: "pull_request",
      name: "CI",
      headSha: head,
      pullRequests: [7],
    }),
    getPullRequest: async () => pr,
    associatedPullRequests: async () => [],
    getPermission: async (_repo, actor) => {
      calls.push(`permission:${actor}`);
      return "write";
    },
    readContent: async (_repo, path, sha) => {
      calls.push(`content:${path}:${sha}`);
      return config;
    },
    listChangedFiles: async () => {
      calls.push("files");
      return [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1 }];
    },
  };
  return { reader, pr, calls };
}

afterEach(() => vi.restoreAllMocks());
describe("preflight pipeline", () => {
  it("returns a safe exact identity with changed-file statistics and base config", async () => {
    const { reader, calls } = fixture();
    expect(await runPreflight(input, reader)).toEqual({
      schema_version: 1,
      mode: "automatic",
      status: "READY",
      unable_reason: null,
      repository: "owner/repo",
      pr_number: 7,
      base_branch: "main",
      base_sha: base,
      head_sha: head,
      linear_issue: "ANY-451",
      review_attempt_identity: attempt,
      review_identity: { ...attempt, linear_issue: "ANY-451" },
      changed_files: [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1 }],
    });
    expect(calls).toEqual(["permission:author", `content:.github/ai-review.yml:${base}`, "files"]);
  });
  it.each(["read", "triage", "none", "unknown"])(
    "skips unauthorized automatic permission %s before config/model/Linear access",
    async (permission) => {
      const { reader, calls } = fixture();
      const secretFetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected secret-service network access"));
      reader.getPermission = async () => permission;
      const result = await runPreflight(input, reader);
      expect(result).toMatchObject({ status: "UNAUTHORIZED_SKIPPED", unable_reason: null });
      expect(calls).toEqual([]);
      expect(secretFetch).not.toHaveBeenCalled();
    },
  );
  it.each(["write", "maintain", "admin"])("allows automatic permission %s", async (permission) => {
    const { reader } = fixture();
    reader.getPermission = async () => permission;
    expect(await runPreflight(input, reader)).toMatchObject({ status: "READY" });
  });
  it.each(["push", "stale", "closed"])(
    "skips %s without secret calls or config access",
    async (kind) => {
      const { reader, pr, calls } = fixture();
      if (kind === "push")
        reader.getWorkflowRun = async () => ({
          event: "push",
          name: "CI",
          headSha: head,
          pullRequests: [7],
        });
      if (kind === "stale") pr.headSha = "c".repeat(40);
      if (kind === "closed") pr.state = "closed";
      const secretFetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected secret-service network access"));
      const result = await runPreflight(input, reader);
      expect(result.status).toBe(kind === "stale" ? "STALE_SKIPPED" : "NOT_APPLICABLE_SKIPPED");
      expect(result.unable_reason).toBeNull();
      expect(calls).toEqual([]);
      expect(secretFetch).not.toHaveBeenCalled();
    },
  );
  it("authorizes manual dispatch actor rather than external author", async () => {
    const { reader, calls } = fixture();
    expect(
      await runPreflight(
        {
          mode: "manual",
          repository: "owner/repo",
          prNumber: 7,
          actor: "maintainer",
          engineSha: engine,
        },
        reader,
      ),
    ).toMatchObject({ status: "READY" });
    expect(calls[0]).toBe("permission:maintainer");
  });
  it("retains attempt identity when metadata is invalid", async () => {
    const { reader, pr } = fixture();
    pr.body = "private invalid body";
    const result = await runPreflight(input, reader);
    expect(result).toMatchObject({
      status: "UNABLE_TO_REVIEW",
      unable_reason: "PR_METADATA_INVALID",
      review_attempt_identity: attempt,
      review_identity: null,
      linear_issue: null,
    });
    expect(JSON.stringify(result)).not.toContain("private invalid body");
  });
  it.each([
    [undefined, "CONFIG_MISSING"],
    ["policy: [", "CONFIG_INVALID"],
    [config.replace("CI", "Other CI"), "CONFIG_INVALID"],
  ] as const)("uses typed base config failures", async (source, reason) => {
    const { reader } = fixture();
    reader.readContent = async () => source;
    expect(await runPreflight(input, reader)).toMatchObject({
      status: "UNABLE_TO_REVIEW",
      unable_reason: reason,
      review_attempt_identity: attempt,
      review_identity: { ...attempt, linear_issue: "ANY-451" },
    });
  });
  it("keeps transport failures distinct and strips error content", async () => {
    const { reader } = fixture();
    reader.readContent = async () => {
      throw new Error("SECRET token");
    };
    const result = await runPreflight(input, reader);
    expect(result).toMatchObject({ status: "UNABLE_TO_REVIEW", unable_reason: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it.each([
    [251, 2, 1],
    [1, 20000, 1],
  ])(
    "rejects size limit %i files/%i additions/%i deletions before file fetching",
    async (files, additions, deletions) => {
      const { reader, pr, calls } = fixture();
      Object.assign(pr, { changedFiles: files, additions, deletions });
      expect(await runPreflight(input, reader)).toMatchObject({
        status: "UNABLE_TO_REVIEW",
        unable_reason: "PR_TOO_LARGE",
        review_identity: { ...attempt, linear_issue: "ANY-451" },
      });
      expect(calls).not.toContain("files");
    },
  );
  it("accepts exact limits and preserves complete paginated metadata", async () => {
    const { reader, pr } = fixture();
    Object.assign(pr, { changedFiles: 250, additions: 10000, deletions: 10000 });
    reader.listChangedFiles = async () =>
      Array.from({ length: 250 }, (_, i) => ({
        filename: `src/${i}.ts`,
        status: "modified",
        additions: 40,
        deletions: 40,
      }));
    expect(await runPreflight(input, reader)).toMatchObject({
      status: "READY",
      changed_files: expect.any(Array),
    });
  });
  it.each(["missing", "wrong totals", "duplicate", "invalid path", "negative"])(
    "fails closed on %s file metadata",
    async (kind) => {
      const { reader, pr } = fixture();
      reader.listChangedFiles = async () =>
        kind === "missing"
          ? []
          : kind === "duplicate"
            ? Array.from({ length: 2 }, () => ({
                filename: "a.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
              }))
            : [
                {
                  filename: kind === "invalid path" ? "../a.ts" : "a.ts",
                  status: "modified",
                  additions: kind === "negative" ? -1 : kind === "wrong totals" ? 5 : 2,
                  deletions: 1,
                },
              ];
      if (kind === "duplicate") Object.assign(pr, { changedFiles: 2, additions: 2, deletions: 0 });
      expect(await runPreflight(input, reader)).toMatchObject({
        status: "UNABLE_TO_REVIEW",
        unable_reason: "INTERNAL_ERROR",
      });
    },
  );
  it("rechecks current base/head after paginated mutable PR reads", async () => {
    const { reader, pr } = fixture();
    let reads = 0;
    reader.getPullRequest = async () => ({ ...pr, headSha: ++reads > 1 ? "c".repeat(40) : head });
    expect(await runPreflight(input, reader)).toMatchObject({
      status: "STALE_SKIPPED",
      unable_reason: null,
    });
  });
  it.each(["short", "g".repeat(40), `${engine}\n`])(
    "rejects untrusted/invalid engine SHA %j before GitHub access",
    async (engineSha) => {
      const { reader, calls } = fixture();
      await expect(runPreflight({ ...input, engineSha }, reader)).rejects.toThrow();
      expect(calls).toEqual([]);
    },
  );
});

describe("preflight CLI", () => {
  it("writes safe JSON and eight single-line outputs using trusted engine argument", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preflight-"));
    try {
      const { reader } = fixture();
      const output = join(directory, "output");
      const code = await runCli(
        [
          "--mode",
          "automatic",
          "--repository",
          "owner/repo",
          "--triggering-run-id",
          "42",
          "--engine-sha",
          engine,
        ],
        { RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_SHA: "d".repeat(40) },
        () => reader,
      );
      expect(code).toBe(0);
      const result = JSON.parse(
        await readFile(join(directory, "ai-pr-review", "preflight.json"), "utf8"),
      );
      expect(result.review_identity.engine_sha).toBe(engine);
      expect((await readFile(output, "utf8")).split("\n")).toEqual([
        "status=READY",
        "repository=owner/repo",
        "pr_number=7",
        "base_branch=main",
        `base_sha=${base}`,
        `head_sha=${head}`,
        "linear_issue=ANY-451",
        "unable_reason=",
        "",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ["--mode", "automatic", "--triggering-run-id", "1"],
    ["--mode", "automatic", "--triggering-run-id", "1e3", "--engine-sha", engine],
    ["--mode", "manual", "--pr-number", "7", "--engine-sha", engine],
    ["--mode", "automatic", "--triggering-run-id", "1", "--engine-sha", engine, "--unknown", "x"],
  ])("fails closed on invalid CLI arguments %j", async (...args) => {
    const directory = await mkdtemp(join(tmpdir(), "preflight-"));
    try {
      let clients = 0;
      expect(
        await runCli(
          [...args, "--repository", "owner/repo"],
          { RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "output") },
          () => {
            clients++;
            return fixture().reader;
          },
        ),
      ).toBeGreaterThanOrEqual(70);
      expect(clients).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects newline output injection from PR metadata", async () => {
    const { reader, pr } = fixture();
    pr.baseBranch = "main\nstatus=READY";
    expect(await runPreflight(input, reader)).toMatchObject({
      status: "UNABLE_TO_REVIEW",
      unable_reason: "INTERNAL_ERROR",
      base_branch: null,
    });
  });
});

describe("malformed GitHub identity", () => {
  it("rejects a SHA with a trailing newline before retaining identity", async () => {
    const { reader, pr } = fixture();
    pr.baseSha = `${base}\n`;
    expect(await runPreflight(input, reader)).toMatchObject({
      status: "UNABLE_TO_REVIEW",
      unable_reason: "INTERNAL_ERROR",
      review_attempt_identity: null,
    });
  });
});

it("manual CLI uses trusted dispatch actor and writes skip as a successful valid output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preflight-"));
  try {
    const { reader } = fixture();
    const actors: string[] = [];
    reader.getPermission = async (_repository, actor) => {
      actors.push(actor);
      return "read";
    };
    expect(
      await runCli(
        [
          "--mode",
          "manual",
          "--repository",
          "owner/repo",
          "--pr-number",
          "7",
          "--engine-sha",
          engine,
        ],
        {
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: join(directory, "output"),
          GITHUB_ACTOR: "maintainer",
        },
        () => reader,
      ),
    ).toBe(0);
    expect(actors).toEqual(["maintainer"]);
    const result = JSON.parse(
      await readFile(join(directory, "ai-pr-review", "preflight.json"), "utf8"),
    );
    expect(result).toMatchObject({ status: "UNAUTHORIZED_SKIPPED", unable_reason: null });
    expect(await readFile(join(directory, "output"), "utf8")).toContain(
      "status=UNAUTHORIZED_SKIPPED\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
