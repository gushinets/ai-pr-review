import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildReviewSnapshot } from "../../src/context/snapshot.js";
import { CENTRAL_CONFIG } from "../../src/config/central-config.js";
import type { ReviewContextV1 } from "../../src/contracts/review-context.js";
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function input() {
  const privateDir = await mkdtemp(join(tmpdir(), "snapshot-test-"));
  temps.push(privateDir);
  await mkdir(join(privateDir, "ci-logs"));
  await writeFile(join(privateDir, "ci-logs/3-4.log"), "sanitized failure");
  const head = "a".repeat(40);
  const context: ReviewContextV1 = {
    schema_version: 1,
    review_identity: {
      repository: "o/r",
      pr_number: 1,
      base_sha: "b".repeat(40),
      head_sha: head,
      engine_sha: "c".repeat(40),
      linear_issue: "ANY-1",
    },
    base_branch: "main",
    changed_files: [],
    diff_stats: { files: 0, additions: 0, deletions: 0 },
    policy_paths: ["AGENTS.md"],
    requirements_path: "requirements/linear.json",
    diff_path: "diff/pr.diff",
    ci: {
      schema_version: 1,
      head_sha: head,
      primary_ci_workflow: "CI",
      checks: [
        {
          kind: "check_run",
          name: "test",
          status: "completed",
          conclusion: "failure",
          details_url: null,
          workflow_run_id: 3,
          job_id: 4,
          failed_log_path: "ci-logs/3-4.log",
        },
      ],
    },
  };
  return {
    privateDir,
    headArchive: {
      headSha: head,
      stream: createReadStream(
        new URL("../../fixtures/security/archive-inert.tar", import.meta.url),
      ),
    },
    context,
    policy: [{ path: "AGENTS.md", content: "TRUSTED_BASE" }],
    requirements: {
      schema_version: 1 as const,
      identifier: "ANY-1",
      title: "PRIVATE_LINEAR",
      description: "private requirements",
      comments: [],
    },
    unifiedDiff: "",
    changedFiles: [],
    ciSourceRoot: privateDir,
  };
}
it("builds inert HEAD evidence, trusted BASE policy and mapped private context in sibling roots", async () => {
  const request = await input();
  const result = await buildReviewSnapshot(request);
  const read = (p: string) => readFile(join(result.reviewRoot, p), "utf8");
  expect(await read("control/policy/AGENTS.md")).toBe("TRUSTED_BASE");
  for (const p of [
    "AGENTS.md",
    ".rejudge/config.json",
    ".pi/extensions/evil.js",
    ".github/actions/evil/action.yml",
    "package.json",
    "run.sh",
  ]) {
    expect(await read("target/" + p)).toBe("UNTRUSTED_HEAD");
    expect((await lstat(join(result.reviewRoot, "target", p))).isFile()).toBe(true);
    if (process.platform !== "win32")
      expect((await lstat(join(result.reviewRoot, "target", p))).mode & 0o111).toBe(0);
  }
  expect(JSON.parse(await read(".rejudge/config.json"))).toEqual({
    reviewers: CENTRAL_CONFIG.reviewers.map((m) => `${m.model}@${m.level}`),
    judge: `${CENTRAL_CONFIG.judge.model}@${CENTRAL_CONFIG.judge.level}`,
    debugLog: false,
  });
  expect(await read("requirements/linear.json")).toContain("PRIVATE_LINEAR");
  expect(await read("evidence/ci/3-4.log")).toBe("sanitized failure");
  expect(result.context.ci.checks[0]?.failed_log_path).toBe("evidence/ci/3-4.log");
  expect(result.context.policy_paths).toEqual(["control/policy/AGENTS.md"]);
  expect(JSON.parse(await read("metadata/review-context.json"))).toEqual(result.context);
  expect(JSON.parse(await read("evidence/ci/status.json"))).toEqual(result.context.ci);
  expect(await read("diff/pr.diff")).toBe("");
  expect(await read("diff/numstat.txt")).toBe("");
  expect(result.runtimeDir).toBe(join(request.privateDir, "runtime"));
  for (const p of ["home", "xdg", "tmp", "pi-agent", "bin"])
    expect((await lstat(join(result.runtimeDir, p))).isDirectory()).toBe(true);
  expect(request.context.ci.checks[0]?.failed_log_path).toBe("ci-logs/3-4.log");
});
it.each(["archive", "ci", "policy", "log"] as const)(
  "rejects mismatched/unsafe %s inputs",
  async (field) => {
    const request = await input();
    if (field === "archive") request.headArchive.headSha = "d".repeat(40);
    if (field === "ci") request.context.ci.head_sha = "d".repeat(40);
    if (field === "policy") request.policy[0]!.path = "../outside";
    if (field === "log") request.context.ci.checks[0]!.failed_log_path = "../outside";
    await expect(buildReviewSnapshot(request)).rejects.toThrow();
    request.headArchive.stream.destroy();
  },
);

it("rejects duplicate changed-file metadata instead of hiding another diff section", async () => {
  const request = await input();
  const patch = (name: string) =>
    `diff --git a/${name} b/${name}\nold mode 100644\nnew mode 100755\n`;
  const changedFiles = ["a", "a"].map((filename) => ({
    filename,
    status: "modified",
    additions: 0,
    deletions: 0,
  }));
  await expect(
    buildReviewSnapshot({ ...request, unifiedDiff: patch("a") + patch("b"), changedFiles }),
  ).rejects.toThrow("SNAPSHOT_FAILED");
  request.headArchive.stream.destroy();
});
it("accepts final review-root CI evidence paths while reading only the matching private sanitized log", async () => {
  const request = await input();
  request.context.ci.checks[0]!.failed_log_path = "evidence/ci/3-4.log";
  const result = await buildReviewSnapshot(request);
  expect(await readFile(join(result.reviewRoot, "evidence/ci/3-4.log"), "utf8")).toBe(
    "sanitized failure",
  );
  expect(result.context.ci.checks[0]?.failed_log_path).toBe("evidence/ci/3-4.log");
});
