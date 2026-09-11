import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCiContext, sanitizeCiLog } from "../../src/github/ci-context.js";
import type { GithubReadClient, GitHubCheckRun } from "../../src/github/github-client.js";

const head = "a".repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function workdir() {
  const dir = await mkdtemp(join(tmpdir(), "ci-context-"));
  dirs.push(dir);
  return dir;
}
const check = (
  id: number,
  name: string,
  conclusion: string | null = "success",
): GitHubCheckRun => ({
  id,
  name,
  headSha: head,
  status: conclusion === null ? "pending" : "completed",
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/10/job/${id}`,
  externalId: null,
  appId: 1,
});
function fixture(checks = [check(1, "CI")]) {
  const downloads: number[] = [];
  const reader = {
    listCheckRuns: async (_repo: string, sha: string) => {
      expect(sha).toBe(head);
      return checks;
    },
    getCommitStatuses: async (_repo: string, sha: string) => {
      expect(sha).toBe(head);
      return {
        sha: head,
        statuses: [{ id: 99, context: "aux", state: "pending", targetUrl: null }],
      };
    },
    listWorkflowRuns: async (_repo: string, sha: string) => {
      expect(sha).toBe(head);
      return [{ id: 10, headSha: head }];
    },
    listWorkflowJobs: async () =>
      checks.map((c) => ({
        id: c.id,
        runId: 10,
        headSha: head,
        checkRunUrl: `https://api.github.com/repos/o/r/check-runs/${c.id}`,
      })),
    downloadJobLog: async (_repo: string, id: number) => {
      downloads.push(id);
      return "Authorization: Bearer ghp_FAKE_SECRET\r\nQWEN_API_KEY=sk-ws-FAKE\nLINEAR_CLIENT_SECRET=fake-linear-secret\n\x1b[31mred ansi\x1b[0m\nknown-canary";
    },
  } as unknown as GithubReadClient;
  return { reader, downloads };
}

describe("CI log sanitization", () => {
  it("redacts known and common secrets after ANSI/control removal and CR normalization", () => {
    const raw =
      "Authorization: Bearer ghp_FAKE_SECRET\r\nQWEN_API_KEY=sk-ws-FAKE\rLINEAR_CLIENT_SECRET=fake-linear-secret\nGITHUB_TOKEN='token secret'\nDB_PASSWORD=\"password secret\"\nAPI_KEY=api-secret\nBearer bearer-secret\n\x1b[31mred ansi\x1b[0m\nknown-canary\x00\x07\x80\x9f\tend";
    const sanitized = sanitizeCiLog(raw, ["known-canary", "", "known"]);
    for (const value of [
      "ghp_FAKE_SECRET",
      "sk-ws-FAKE",
      "fake-linear-secret",
      "token secret",
      "password secret",
      "api-secret",
      "bearer-secret",
      "known-canary",
      "\r",
      "\x1b",
      "\x00",
      "\x80",
      "\x9f",
    ])
      expect(sanitized).not.toContain(value);
    expect(sanitized).toContain("red ansi\n[REDACTED]\tend");
    expect(sanitizeCiLog("x\r\ny\rz\t!", [])).toBe("x\ny\nz\t!");
  });
  it("does not expose assignment-only environment dumps or Actions env blocks", () => {
    const text = sanitizeCiLog(
      "HOME=/private/home\nCUSTOM_CREDENTIAL=opaque-canary\n  env:\n    HOME: /another/private\n    CUSTOM_CREDENTIAL: another-canary\nactual failure",
      [],
    );
    for (const secret of ["/private/home", "opaque-canary", "/another/private", "another-canary"])
      expect(text).not.toContain(secret);
    expect(text).toContain("actual failure");
  });
  it("bounds UTF-8 output including the marker without splitting multibyte characters", () => {
    const exact = "x".repeat(512 * 1024);
    expect(sanitizeCiLog(exact, [])).toBe(exact);
    const result = sanitizeCiLog("🙂".repeat(200_000), []);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(512 * 1024);
    expect(result.endsWith("[TRUNCATED BY AI PR REVIEW]")).toBe(true);
    expect(result).not.toContain("�");
  });
});

describe("exact-head CI collection", () => {
  it("keeps successful and pending checks without downloading successful logs", async () => {
    const { reader, downloads } = fixture();
    const ci = await loadCiContext(reader, "o/r", head, "CI", await workdir());
    expect(ci).toEqual({
      schema_version: 1,
      head_sha: head,
      primary_ci_workflow: "CI",
      checks: [
        {
          kind: "check_run",
          name: "CI",
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/o/r/actions/runs/10/job/1",
          workflow_run_id: 10,
          job_id: 1,
          failed_log_path: null,
        },
        {
          kind: "commit_status",
          name: "aux",
          status: "pending",
          conclusion: null,
          details_url: null,
          workflow_run_id: null,
          job_id: null,
          failed_log_path: null,
        },
      ],
    });
    expect(downloads).toEqual([]);
  });
  it.each(["failure", "timed_out", "cancelled"])(
    "writes sanitized %s evidence only under the private workdir",
    async (conclusion) => {
      const { reader, downloads } = fixture([check(1, "CI", conclusion)]);
      const dir = await workdir();
      const ci = await loadCiContext(reader, "o/r", head, "CI", dir, ["known-canary"]);
      expect(ci.checks[0]?.failed_log_path).toBe("ci-logs/10-1.log");
      const log = await readFile(join(dir, "ci-logs/10-1.log"), "utf8");
      expect(log).toContain("red ansi");
      for (const secret of [
        "ghp_FAKE_SECRET",
        "sk-ws-FAKE",
        "fake-linear-secret",
        "known-canary",
        "\x1b",
      ])
        expect(log).not.toContain(secret);
      expect(downloads).toEqual([1]);
      expect(await readdir(dir)).toEqual(["ci-logs"]);
    },
  );
  it.each(["action_required", "neutral", "skipped", "stale", "startup_failure"])(
    "does not download ineligible %s logs",
    async (conclusion) => {
      const { reader, downloads } = fixture([check(1, "CI", conclusion)]);
      expect(
        (await loadCiContext(reader, "o/r", head, "CI", await workdir())).checks[0]
          ?.failed_log_path,
      ).toBeNull();
      expect(downloads).toEqual([]);
    },
  );
  it("preserves statuses and gives a safe warning when optional logs are unavailable", async () => {
    const { reader } = fixture([check(1, "CI", "failure")]);
    const warnings: string[] = [];
    reader.downloadJobLog = async () => {
      throw new Error("SECRET_FROM_SERVER");
    };
    const ci = await loadCiContext(reader, "o/r", head, "CI", await workdir(), [], (warning) =>
      warnings.push(warning),
    );
    expect(ci.checks[0]).toMatchObject({ conclusion: "failure", failed_log_path: null });
    expect(warnings).toEqual(["CI_JOB_LOG_UNAVAILABLE"]);
  });
  it("uses check-run IDs rather than names or attacker-supplied job URLs to map logs", async () => {
    const { reader, downloads } = fixture([
      check(1, "same", "failure"),
      check(2, "same", "failure"),
    ]);
    reader.listWorkflowJobs = async () => [
      {
        id: 8,
        runId: 10,
        headSha: head,
        checkRunUrl: "https://evil.invalid/repos/o/r/check-runs/1",
      },
      {
        id: 9,
        runId: 10,
        headSha: head,
        checkRunUrl: "https://api.github.com/repos/o/r/check-runs/2",
      },
    ];
    const ci = await loadCiContext(reader, "o/r", head, "CI", await workdir());
    expect(ci.checks.map((c) => [c.name, c.job_id])).toEqual([
      ["aux", null],
      ["same", null],
      ["same", 9],
    ]);
    expect(downloads).toEqual([9]);
  });
  it("keeps mandatory statuses when optional job discovery fails or jobs have another head", async () => {
    const { reader, downloads } = fixture([check(1, "CI", "failure")]);
    reader.listWorkflowJobs = async () => [
      {
        id: 1,
        runId: 10,
        headSha: "b".repeat(40),
        checkRunUrl: "https://api.github.com/repos/o/r/check-runs/1",
      },
    ];
    expect(
      (await loadCiContext(reader, "o/r", head, "CI", await workdir())).checks[0]?.job_id,
    ).toBeNull();
    reader.listWorkflowRuns = async () => {
      throw new Error("private error");
    };
    expect(
      (await loadCiContext(reader, "o/r", head, "CI", await workdir())).checks[0]?.conclusion,
    ).toBe("failure");
    expect(downloads).toEqual([]);
  });
  it.each(["listCheckRuns", "getCommitStatuses"] as const)(
    "fails closed when %s cannot be read",
    async (method) => {
      const { reader } = fixture();
      reader[method] = async () => {
        throw new Error("SECRET");
      };
      await expect(loadCiContext(reader, "o/r", head, "CI", await workdir())).rejects.toMatchObject(
        { reason: "CI_CONTEXT_UNAVAILABLE", message: "CI_CONTEXT_UNAVAILABLE" },
      );
    },
  );
  it.each(["check", "status"])(
    "rejects mismatched %s SHA before evidence download",
    async (kind) => {
      const { reader, downloads } = fixture([
        { ...check(1, "CI", "failure"), ...(kind === "check" ? { headSha: "b".repeat(40) } : {}) },
      ]);
      if (kind === "status")
        reader.getCommitStatuses = async () => ({ sha: "b".repeat(40), statuses: [] });
      await expect(loadCiContext(reader, "o/r", head, "CI", await workdir())).rejects.toMatchObject(
        { reason: "CI_CONTEXT_UNAVAILABLE" },
      );
      expect(downloads).toEqual([]);
    },
  );
  it("deduplicates external identities, preserves distinct jobs and sorts deterministically", async () => {
    const checks = [
      { ...check(3, "Z", "failure"), externalId: "same" },
      { ...check(4, "Z"), externalId: "same" },
      check(2, "A"),
      check(1, "A"),
    ];
    const { reader } = fixture(checks);
    reader.getCommitStatuses = async () => ({
      sha: head,
      statuses: [
        { id: 1, context: "legacy", state: "failure", targetUrl: null },
        { id: 2, context: "legacy", state: "success", targetUrl: null },
        { id: 3, context: "error", state: "error", targetUrl: null },
      ],
    });
    const first = await loadCiContext(reader, "o/r", head, "CI", await workdir());
    checks.reverse();
    expect(await loadCiContext(reader, "o/r", head, "CI", await workdir())).toEqual(first);
    expect(first.checks.map((c) => [c.name, c.job_id, c.conclusion])).toEqual([
      ["A", 1, "success"],
      ["A", 2, "success"],
      ["Z", 4, "success"],
      ["error", null, "failure"],
      ["legacy", null, "success"],
    ]);
  });
  it.each(["queued", "in_progress", "completed", "waiting", "requested", "pending"])(
    "preserves supported check status %s",
    async (status) => {
      const { reader } = fixture([{ ...check(1, "CI", null), status }]);
      expect(
        (await loadCiContext(reader, "o/r", head, "CI", await workdir())).checks[0]?.status,
      ).toBe(status);
    },
  );
  it.each([{ status: "unknown" }, { conclusion: "unknown" }, { id: -1 }, { name: "" }])(
    "rejects malformed check data %#",
    async (override) => {
      const { reader } = fixture([{ ...check(1, "CI"), ...override }]);
      await expect(loadCiContext(reader, "o/r", head, "CI", await workdir())).rejects.toMatchObject(
        { reason: "CI_CONTEXT_UNAVAILABLE" },
      );
    },
  );
});

describe("private CI evidence files", () => {
  it("does not follow a ci-logs directory symlink outside the private workdir", async () => {
    const dir = await workdir();
    const outside = await workdir();
    const warnings: string[] = [];
    await symlink(outside, join(dir, "ci-logs"), "junction");
    const { reader } = fixture([check(1, "CI", "failure")]);
    const ci = await loadCiContext(reader, "o/r", head, "CI", dir, [], (warning) =>
      warnings.push(warning),
    );
    expect(ci.checks[0]?.failed_log_path).toBeNull();
    expect(await readdir(outside)).toEqual([]);
    expect(warnings).toEqual(["CI_JOB_LOG_UNAVAILABLE"]);
  });
  it("never overwrites or trusts an existing evidence file", async () => {
    const dir = await workdir();
    await mkdir(join(dir, "ci-logs"));
    await writeFile(join(dir, "ci-logs/10-1.log"), "untrusted-existing-canary");
    const { reader } = fixture([check(1, "CI", "failure")]);
    const ci = await loadCiContext(reader, "o/r", head, "CI", dir, [], () => {});
    expect(ci.checks[0]?.failed_log_path).toBeNull();
    expect(await readFile(join(dir, "ci-logs/10-1.log"), "utf8")).toBe("untrusted-existing-canary");
  });
  it("does not download logs from ambiguous job mappings", async () => {
    const { reader, downloads } = fixture([check(1, "CI", "failure")]);
    reader.listWorkflowJobs = async () =>
      [1, 2].map((id) => ({
        id,
        runId: 10,
        headSha: head,
        checkRunUrl: "https://api.github.com/repos/o/r/check-runs/1",
      }));
    expect(
      (await loadCiContext(reader, "o/r", head, "CI", await workdir())).checks[0]?.job_id,
    ).toBeNull();
    expect(downloads).toEqual([]);
  });
});
