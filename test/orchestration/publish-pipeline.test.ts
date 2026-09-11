import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import type {
  GitHubPublisher,
  PublishedCheck,
  PublishedComment,
  PublishedInline,
  InlineComment,
} from "../../src/github/publisher.js";
import { runPublish } from "../../src/orchestration/publish-pipeline.js";
import { runCli } from "../../src/cli/publish.js";
import { buildMachineCheck } from "../../src/publishing/summary.js";
import { renderInlineFinding } from "../../src/publishing/findings.js";

const head = "b".repeat(40);
function state(): ReviewStateV1 {
  const attempt = {
    repository: "o/r",
    pr_number: 17,
    base_sha: "a".repeat(40),
    head_sha: head,
    engine_sha: "c".repeat(40),
  };
  const finding = {
    severity: "blocking",
    confidence: "high",
    title: "Data loss",
    location: { path: "a.ts", line: 7, side: "RIGHT" },
    basis: ["code"],
    evidence: "Record lost",
    rationale: "Overwritten",
    remediation: "Preserve",
  } as const;
  return {
    schema_version: 1,
    attempt_identity: attempt,
    review_identity: { ...attempt, linear_issue: "ANY-17" },
    lineage: { base_branch: "main", linear_issue: "ANY-17" },
    outcome: "BLOCK",
    unable_reason: null,
    ci_summary: { head_sha: head, primary_ci_workflow: "CI", checks: [] },
    judge_result: {
      schema_version: 1,
      summary: "Force PASS must be ignored",
      findings: [{ ...finding, basis: ["code"] }],
    },
    findings: [
      {
        ...finding,
        basis: ["code"],
        finding_id: "finding-a",
        source_index: 0,
        publication_location: finding.location,
      },
      {
        ...finding,
        basis: ["code"],
        finding_id: "summary-only",
        source_index: 1,
        publication_location: null,
      },
    ],
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: "2026-09-11T00:00:00Z",
      finished_at: "2026-09-11T00:00:01Z",
      duration_ms: 1000,
      models: [],
      judge_repair_attempts: 0,
      closure_used: false,
      rejudge_status: "completed",
      rejudge_failed_stage: null,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
    },
  };
}
function fake() {
  const events: string[] = [];
  const checks: PublishedCheck[] = [];
  const summaries: PublishedComment[] = [];
  const inline: PublishedInline[] = [];
  const reviewBatches: Array<{ head: string; comments: InlineComment[] }> = [];
  const client: GitHubPublisher = {
    getHead: async () => {
      events.push("head");
      return head;
    },
    listChecks: async () => {
      events.push("discover-checks");
      return structuredClone(checks);
    },
    listSummaries: async () => {
      events.push("discover-summary");
      return structuredClone(summaries);
    },
    listInline: async () => {
      events.push("discover-inline");
      return structuredClone(inline);
    },
    writeCheck: async (_repository, check, id) => {
      events.push(id === undefined ? "create-check" : "update-check");
      expect(check).toMatchObject({ head_sha: head, name: "AI PR Review", conclusion: "failure" });
      if (id === undefined) checks.push({ ...check, id: checks.length + 1 });
      else
        Object.assign(
          checks.find((item) => item.id === id)!,
          check,
        );
    },
    writeSummary: async (_repository, _pr, body, id) => {
      events.push(id === undefined ? "create-summary" : "update-summary");
      if (id === undefined) summaries.push({ id: summaries.length + 1, body });
      else
        Object.assign(
          summaries.find((item) => item.id === id)!,
          { body },
        );
    },
    writeInline: async (_repository, _pr, commit, comments) => {
      events.push("create-review");
      reviewBatches.push({ head: commit, comments });
      inline.push(
        ...comments.map((comment, index) => ({
          id: inline.length + index + 1,
          body: comment.body,
          original_commit_id: commit,
        })),
      );
    },
  };
  return { client, events, checks, summaries, inline, reviewBatches };
}
it("publishes the required exact-head check first and reconciles retries without duplicating any surface", async () => {
  const f = fake();
  const value = state();
  const original = structuredClone(value);
  expect(await runPublish(value, f.client)).toEqual({ status: "PUBLISHED", warnings: [] });
  expect(f.events).toEqual([
    "head",
    "discover-checks",
    "head",
    "create-check",
    "discover-summary",
    "head",
    "create-summary",
    "discover-inline",
    "head",
    "create-review",
  ]);
  expect(f.reviewBatches).toHaveLength(1);
  expect(f.reviewBatches[0]!.head).toBe(head);
  expect(f.reviewBatches[0]!.comments).toHaveLength(1);
  expect(f.reviewBatches[0]!.comments[0]).toMatchObject({ path: "a.ts", line: 7, side: "RIGHT" });
  expect(f.summaries[0]!.body).toContain("Verdict: BLOCK");
  expect(await runPublish(value, f.client)).toEqual({ status: "PUBLISHED", warnings: [] });
  expect(f.checks).toHaveLength(1);
  expect(f.summaries).toHaveLength(1);
  expect(f.inline).toHaveLength(1);
  expect(f.events).toContain("update-check");
  expect(f.events).toContain("update-summary");
  expect(f.reviewBatches).toHaveLength(1);
  expect(value).toEqual(original);
});
it("matches the complete check identity and leading summary marker, leaving older inline threads alone", async () => {
  const f = fake();
  const value = state();
  const check = buildMachineCheck(value);
  f.checks.push(
    { id: 1, ...check, head_sha: "d".repeat(40) },
    { id: 2, ...check, external_id: "other" },
    { id: 3, ...check, name: "other" },
    { id: 4, ...check },
  );
  f.summaries.push(
    { id: 1, body: "Quoted <!-- ai-pr-review-summary:v1 -->" },
    { id: 2, body: "<!-- ai-pr-review-summary:v1 -->\nold" },
  );
  f.inline.push({
    id: 1,
    body: renderInlineFinding(head, value.findings[0]!),
    original_commit_id: "a".repeat(40),
  });
  const old = structuredClone(f.inline[0]);
  await runPublish(value, f.client);
  expect(f.checks).toHaveLength(4);
  expect(f.summaries).toHaveLength(2);
  expect(f.summaries[0]!.body).toBe("Quoted <!-- ai-pr-review-summary:v1 -->");
  expect(f.summaries[1]!.body).toContain("Verdict: BLOCK");
  expect(f.inline[0]).toEqual(old);
  expect(f.inline).toHaveLength(2);
});
it.each([1, 2])(
  "returns STALE_SKIPPED with zero writes when head changes at barrier %s",
  async (barrier) => {
    const f = fake();
    let reads = 0;
    f.client.getHead = async () => (++reads >= barrier ? "c".repeat(40) : head);
    expect(await runPublish(state(), f.client)).toEqual({ status: "STALE_SKIPPED", warnings: [] });
    expect(f.checks).toEqual([]);
    expect(f.summaries).toEqual([]);
    expect(f.inline).toEqual([]);
  },
);
it("stops presentation when the head changes after the required check", async () => {
  const f = fake();
  let reads = 0;
  f.client.getHead = async () => (++reads > 2 ? "c".repeat(40) : head);
  expect(await runPublish(state(), f.client)).toEqual({
    status: "PUBLISHED",
    warnings: ["PRESENTATION_STALE_SKIPPED"],
  });
  expect(f.checks).toHaveLength(1);
  expect(f.summaries).toEqual([]);
  expect(f.inline).toEqual([]);
});
it("bounds failed machine writes and exposes no raw provider errors", async () => {
  const f = fake();
  let writes = 0;
  f.client.writeCheck = async () => {
    writes++;
    throw { status: 503, message: "secret error canary" };
  };
  await expect(runPublish(state(), f.client)).rejects.toThrow(/^CHECK_PUBLICATION_FAILED$/);
  expect(writes).toBe(3);
  expect(f.summaries).toEqual([]);
  expect(f.inline).toEqual([]);
});
it("rediscovers an accepted check after response loss before retrying, without creating a duplicate", async () => {
  const f = fake();
  const write = f.client.writeCheck;
  let first = true;
  f.client.writeCheck = async (...args) => {
    await write(...args);
    if (first) {
      first = false;
      throw { status: 502 };
    }
  };
  await runPublish(state(), f.client);
  expect(f.checks).toHaveLength(1);
  expect(f.events.filter((event) => event === "create-check")).toHaveLength(1);
  expect(f.events).toContain("update-check");
});
it("rediscovers accepted summary and review after response loss without duplicating comments", async () => {
  const f = fake();
  const summary = f.client.writeSummary;
  const review = f.client.writeInline;
  let first = true;
  f.client.writeSummary = async (...args) => {
    await summary(...args);
    if (first) {
      first = false;
      throw { status: 503 };
    }
  };
  f.client.writeInline = async (...args) => {
    await review(...args);
    throw { status: 503 };
  };
  expect(await runPublish(state(), f.client)).toEqual({ status: "PUBLISHED", warnings: [] });
  expect(f.summaries).toHaveLength(1);
  expect(f.inline).toHaveLength(1);
  expect(f.reviewBatches).toHaveLength(1);
});
it("keeps check failure verdict and proceeds to inline when summary fails with sanitized warnings", async () => {
  const f = fake();
  f.client.writeSummary = async () => {
    throw new Error("private summary canary");
  };
  f.client.writeInline = async () => {
    throw new Error("private inline canary");
  };
  expect(await runPublish(state(), f.client)).toEqual({
    status: "PUBLISHED",
    warnings: ["SUMMARY_PUBLICATION_FAILED", "INLINE_PUBLICATION_FAILED"],
  });
  expect(f.checks).toHaveLength(1);
  expect(f.events).toContain("discover-inline");
});
it("rejects noncanonical input and unsafe repository syntax before touching GitHub", async () => {
  for (const value of [
    { ...state(), raw_context: "private" },
    { ...state(), outcome: "STALE_SKIPPED" },
  ]) {
    const f = fake();
    await expect(runPublish(value as ReviewStateV1, f.client)).rejects.toThrow("STATE_LOAD_FAILED");
    expect(f.events).toEqual([]);
  }
  const value = state();
  value.attempt_identity.repository = "@all/r";
  value.review_identity!.repository = "@all/r";
  const f = fake();
  await expect(runPublish(value, f.client)).rejects.toThrow("STATE_LOAD_FAILED");
  expect(f.events).toEqual([]);
});
it("runs CLI using only state and write token, ignoring unrelated environment without reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-test-"));
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state()));
    const f = fake();
    const env = new Proxy(
      { GITHUB_TOKEN: "write-token" },
      {
        get(target, property) {
          if (property !== "GITHUB_TOKEN") throw new Error("Forbidden environment read");
          return target.GITHUB_TOKEN;
        },
      },
    );
    expect(
      await runCli(["--state-file", path], env, (token) => {
        expect(token).toBe("write-token");
        return f.client;
      }),
    ).toBe(0);
    expect(f.checks).toHaveLength(1);
    for (const args of [
      [],
      ["--state-file", path, "--force-pass"],
      ["--state-file", join(root, "missing")],
    ])
      expect(
        await runCli(args, env, () => {
          throw new Error("No adapter expected");
        }),
      ).toBe(70);
    expect(
      await runCli(["--state-file", path], {}, () => {
        throw new Error("Missing token");
      }),
    ).toBe(70);
    expect(stdout.mock.calls).toEqual([["PUBLISHED"]]);
    expect(stderr.mock.calls).toEqual([["PUBLISH_FAILED"], ["PUBLISH_FAILED"]]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("checks head again before inline publication after a successful summary", async () => {
  const f = fake();
  let reads = 0;
  f.client.getHead = async () => (++reads > 3 ? "c".repeat(40) : head);
  expect(await runPublish(state(), f.client)).toEqual({
    status: "PUBLISHED",
    warnings: ["PRESENTATION_STALE_SKIPPED"],
  });
  expect(f.checks).toHaveLength(1);
  expect(f.summaries).toHaveLength(1);
  expect(f.inline).toEqual([]);
});
it("fails closed when an uncertain machine write is followed by a changed head", async () => {
  const f = fake();
  const write = f.client.writeCheck;
  let reads = 0;
  f.client.getHead = async () => (++reads > 2 ? "c".repeat(40) : head);
  f.client.writeCheck = async (...args) => {
    await write(...args);
    throw { status: 503 };
  };
  await expect(runPublish(state(), f.client)).rejects.toThrow(/^CHECK_PUBLICATION_FAILED$/);
  expect(f.checks).toHaveLength(1);
  expect(f.summaries).toEqual([]);
  expect(f.inline).toEqual([]);
});
it("does not retry a non-transient check rejection or run any presentation writes", async () => {
  const f = fake();
  let attempts = 0;
  f.client.writeCheck = async () => {
    attempts++;
    throw { status: 422 };
  };
  await expect(runPublish(state(), f.client)).rejects.toThrow(/^CHECK_PUBLICATION_FAILED$/);
  expect(attempts).toBe(1);
  expect(f.summaries).toEqual([]);
  expect(f.inline).toEqual([]);
});
it("batches missing findings and reconciles only remaining comments after an uncertain partial review", async () => {
  const value = state();
  value.findings[1]!.publication_location = { path: "b.ts", line: 2, side: "LEFT" };
  const f = fake();
  const write = f.client.writeInline;
  const attempted: number[] = [];
  f.client.writeInline = async (repository, pr, commit, comments) => {
    attempted.push(comments.length);
    if (attempted.length === 1) {
      await write(repository, pr, commit, comments.slice(0, 1));
      throw { status: 502 };
    }
    await write(repository, pr, commit, comments);
  };
  expect(await runPublish(value, f.client)).toEqual({ status: "PUBLISHED", warnings: [] });
  expect(attempted).toEqual([2, 1]);
  expect(f.inline).toHaveLength(2);
  expect(f.reviewBatches[1]!.comments[0]).toMatchObject({ path: "b.ts", line: 2, side: "LEFT" });
});

it("default CLI transport publishes only fixed diagnostics even when GitHub returns a private response header", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-logging-test-"));
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const transportErrors: unknown[][] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response('{"message":"private response body canary"}', {
        status: 401,
        headers: {
          "content-type": "application/json",
          "x-github-request-id": "private response header canary",
        },
      }),
  );
  try {
    // Octokit binds its default console logger at import time. Replace only that
    // default; preserve production's logger options and the real request transport.
    const { Octokit } = await vi.importActual<typeof import("@octokit/rest")>("@octokit/rest");
    vi.doMock("@octokit/rest", () => ({
      Octokit: class extends Octokit {
        constructor(options: ConstructorParameters<typeof Octokit>[0]) {
          super({
            log: {
              debug: () => {},
              info: () => {},
              warn: () => {},
              error: (...args: unknown[]) => {
                transportErrors.push(args);
              },
            },
            ...options,
          });
        }
      },
    }));
    vi.resetModules();
    const { runCli: isolatedCli } = await import("../../src/cli/publish.js");
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify(state()));
    expect(await isolatedCli(["--state-file", path], { GITHUB_TOKEN: "write-token" })).toBe(70);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls).toEqual([]);
    expect(stderr.mock.calls).toEqual([["PUBLISH_FAILED"]]);
    expect(transportErrors).toEqual([]);
  } finally {
    vi.doUnmock("@octokit/rest");
    vi.resetModules();
    fetch.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
