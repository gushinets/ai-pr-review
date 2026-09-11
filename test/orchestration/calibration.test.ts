import { describe, expect, it } from "vitest";
import {
  buildCalibrationReport,
  type CalibrationSample,
} from "../../src/orchestration/calibration.js";

const sample = (outcome: "PASS" | "BLOCK" | "UNABLE_TO_REVIEW" = "PASS"): CalibrationSample => ({
  outcome,
  verdict: true,
  blockingFindings: outcome === "BLOCK" ? [true] : [],
  materialMiss: false,
  latencyMs: 900000,
  costUsd: null,
});
const ready = () => Array.from({ length: 25 }, (_, i) => sample(i < 10 ? "BLOCK" : "PASS"));

describe("repository calibration metrics", () => {
  it("meets the exact live, quality, reliability and latency boundaries with unknown cost", () => {
    expect(buildCalibrationReport("o/r", ready(), 0)).toEqual({
      schema_version: 1,
      repository: "o/r",
      completed_live_reviews: 25,
      evaluated_blocking_cases: 10,
      completed_review_rate: 1,
      unable_rate: 0,
      false_block_rate: 0,
      blocking_finding_precision: 1,
      material_miss_rate: 0,
      p50_latency_ms: 900000,
      p95_latency_ms: 900000,
      median_cost_usd: null,
      p95_cost_usd: null,
      known_security_boundary_violations: 0,
      stage2_criteria_met: true,
    });
  });
  it.each([
    ["live sample", () => ready().slice(1)],
    ["blocking sample", () => ready().map((s, i) => (i === 0 ? sample() : s))],
    ["false block", () => ready().map((s, i) => (i === 0 ? { ...s, verdict: false } : s))],
    ["precision", () => ready().map((s, i) => (i < 2 ? { ...s, blockingFindings: [false] } : s))],
    ["miss", () => ready().map((s, i) => (i > 22 ? { ...s, materialMiss: true } : s))],
    ["latency", () => ready().map((s) => ({ ...s, latencyMs: 900001 }))],
    ["unknown latency", () => ready().map((s, i) => (i === 0 ? { ...s, latencyMs: null } : s))],
  ] as const)("does not recommend Stage 2 when %s fails", (_, values) => {
    expect(buildCalibrationReport("o/r", values(), 0).stage2_criteria_met).toBe(false);
  });
  it("excludes stale and nonattempt runs but counts missing attempted reviews as inability", () => {
    const report = buildCalibrationReport(
      "o/r",
      [
        ...ready(),
        { ...sample(), outcome: "STALE_SKIPPED" },
        { ...sample(), outcome: "NOT_ATTEMPTED" },
        { ...sample(), outcome: "MISSING_ATTEMPT" },
        sample("UNABLE_TO_REVIEW"),
      ],
      0,
    );
    expect(report.completed_live_reviews).toBe(25);
    expect(report.completed_review_rate).toBe(25 / 27);
    expect(report.unable_rate).toBe(2 / 27);
    expect(report.stage2_criteria_met).toBe(false);
  });
  it("never treats unlabeled silence or a PASS dislike as a material miss", () => {
    const report = buildCalibrationReport(
      "o/r",
      [
        { ...sample("BLOCK"), verdict: null, blockingFindings: [null] },
        { ...sample(), verdict: null },
        { ...sample(), verdict: false },
      ],
      0,
    );
    expect(report.evaluated_blocking_cases).toBe(0);
    expect(report.false_block_rate).toBeNull();
    expect(report.blocking_finding_precision).toBeNull();
    expect(report.material_miss_rate).toBe(0);
    expect(
      buildCalibrationReport("o/r", [{ ...sample(), verdict: null }], 0).material_miss_rate,
    ).toBeNull();
  });
  it("uses nearest-rank p95, conventional median and cost soft alerts never block", () => {
    const report = buildCalibrationReport(
      "o/r",
      ready().map((s, i) => ({ ...s, costUsd: i + 1 })),
      0,
    );
    expect(report.median_cost_usd).toBe(13);
    expect(report.p95_cost_usd).toBe(24);
    expect(report.stage2_criteria_met).toBe(true);
    expect(buildCalibrationReport("o/r", ready(), 1).stage2_criteria_met).toBe(false);
    expect(buildCalibrationReport("o/r", [], 0).completed_review_rate).toBe(0);
  });
});

import { Octokit } from "@octokit/rest";
import { strToU8, zipSync } from "fflate";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import { collectCalibration as collectLiveCalibration } from "../../src/orchestration/calibration.js";
import { renderSummary } from "../../src/publishing/summary.js";
import { renderInlineFinding } from "../../src/publishing/findings.js";

const collectCalibration = (
  octokit: Octokit,
  repository: string,
  incidents: number,
  now = new Date("2026-09-11T01:00:00Z"),
) => collectLiveCalibration(octokit, repository, incidents, now);
const sha = "b".repeat(40);
const engine = "c".repeat(40);
const bot = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const human = { id: 12, login: "maintainer", type: "User" };
function canonical(outcome: "PASS" | "BLOCK" | "UNABLE_TO_REVIEW" = "PASS"): ReviewStateV1 {
  const attempt = {
    repository: "o/r",
    pr_number: 17,
    head_sha: sha,
    base_sha: "a".repeat(40),
    engine_sha: engine,
  };
  const finding = {
    finding_id: "finding1",
    source_index: 0,
    severity: "blocking" as const,
    confidence: "high" as const,
    title: "Guard",
    location: { path: "src/a.ts", line: 2, side: "RIGHT" as const },
    publication_location: { path: "src/a.ts", line: 2, side: "RIGHT" as const },
    basis: ["code" as const],
    evidence: "Unchecked",
    rationale: "Crash",
    remediation: "Validate",
  };
  return {
    schema_version: 1,
    attempt_identity: attempt,
    review_identity: outcome === "UNABLE_TO_REVIEW" ? null : { ...attempt, linear_issue: "ANY-17" },
    lineage: {
      base_branch: "main",
      linear_issue: outcome === "UNABLE_TO_REVIEW" ? null : "ANY-17",
    },
    outcome,
    unable_reason: outcome === "UNABLE_TO_REVIEW" ? "CONFIG_INVALID" : null,
    ci_summary: { head_sha: sha, primary_ci_workflow: "CI", checks: [] },
    judge_result:
      outcome === "UNABLE_TO_REVIEW"
        ? null
        : {
            schema_version: 1,
            summary: "Safe",
            findings:
              outcome === "BLOCK"
                ? [
                    {
                      severity: finding.severity,
                      confidence: finding.confidence,
                      title: finding.title,
                      location: finding.location,
                      basis: finding.basis,
                      evidence: finding.evidence,
                      rationale: finding.rationale,
                      remediation: finding.remediation,
                    },
                  ]
                : [],
          },
    findings: outcome === "BLOCK" ? [finding] : [],
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: "2026-09-11T00:01:00Z",
      finished_at: "2026-09-11T00:10:00Z",
      duration_ms: 540000,
      models: [],
      judge_repair_attempts: 0,
      closure_used: false,
      rejudge_status: outcome === "UNABLE_TO_REVIEW" ? "not_started" : "completed",
      rejudge_failed_stage: null,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
    },
  };
}
interface FixtureOptions {
  states?: ReviewStateV1[];
  missing?: boolean;
  stale?: boolean;
  preflightSkipped?: boolean;
  permission?: string;
  reaction?: string;
  conflict?: boolean;
  oldReaction?: boolean;
  forgedBot?: boolean;
  oldHead?: boolean;
  changedHead?: boolean;
  miss?: string;
  corrupt?: boolean;
  untrusted?: boolean;
  expired?: boolean;
  ciMissing?: boolean;
  rerun?: boolean;
  failedPublisher?: number[];
  runStart?: string;
  createdAt?: string;
  incomplete?: boolean;
  inlineChanged?: boolean;
}
function github(options: FixtureOptions = {}) {
  const states = options.states ?? [canonical()];
  const paths: string[] = [];
  let heads = 0;
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const run = (id: number) => ({
    id,
    run_attempt: options.rerun ? 2 : 1,
    run_started_at: options.runStart ?? "2026-09-11T00:00:30Z",
    created_at: options.createdAt ?? "2026-09-11T00:00:30Z",
    event: "workflow_run",
    path: ".github/workflows/ai-pr-review.yml",
    head_branch: options.untrusted ? "evil" : "main",
    head_sha: "d".repeat(40),
    status: "completed",
    conclusion: "failure",
    repository: { full_name: "o/r" },
    referenced_workflows: [
      {
        path: `gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml@${engine}`,
        sha: engine,
      },
    ],
  });
  const summary = {
    id: 70,
    user: options.forgedBot ? human : bot,
    body: renderSummary(states[0]!),
    created_at: "2026-09-11T00:11:00Z",
    updated_at: "2026-09-11T00:11:00Z",
  };
  const reaction = (content: string) => ({
    id: content === "+1" ? 91 : 92,
    content,
    user: human,
    created_at: options.oldReaction ? "2026-09-11T00:10:30Z" : "2026-09-11T00:12:00Z",
  });
  const octokit = new Octokit({
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;
        paths.push(path);
        expect(init?.method).toBe("GET");
        if (path === "/repos/o/r") return response({ full_name: "o/r", default_branch: "main" });
        if (path.endsWith("/actions/workflows/ai-pr-review.yml/runs"))
          return response({
            total_count: options.incomplete ? 101 : states.length,
            workflow_runs: states.map((_, i) => run(i + 1)),
          });
        if (path.endsWith("/actions/runs") && url.searchParams.get("head_sha") === sha)
          return response({
            total_count: options.ciMissing ? 0 : 1,
            workflow_runs: options.ciMissing
              ? []
              : [
                  {
                    id: 99,
                    name: "CI",
                    event: "pull_request",
                    head_sha: sha,
                    status: "completed",
                    run_attempt: 1,
                    run_started_at: "2026-09-10T23:59:00Z",
                    repository: { full_name: "o/r" },
                    pull_requests: [{ number: 17 }],
                  },
                ],
          });
        if (path.endsWith("/runs/99/jobs"))
          return response({
            total_count: 1,
            jobs: [
              { id: 999, run_id: 99, status: "completed", completed_at: "2026-09-11T00:00:00Z" },
            ],
          });
        const match = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(\/jobs|\/artifacts)?$/.exec(
          path,
        );
        if (match) {
          const id = Number(match[1]);
          if (match[3] === "/artifacts")
            return response({
              total_count: options.missing ? 0 : 1,
              artifacts: options.missing
                ? []
                : [
                    {
                      id,
                      name: "ai-review-state-v1-pr-17",
                      expired: !!options.expired,
                      created_at: "2026-09-11T00:10:30Z",
                      workflow_run: { id },
                    },
                  ],
            });
          if (match[3] === "/jobs")
            return response({
              total_count: 3,
              jobs: [
                {
                  id: id * 10,
                  run_id: id,
                  name: "review / preflight",
                  status: "completed",
                  conclusion: "success",
                  completed_at: "2026-09-11T00:00:40Z",
                  steps: [],
                },
                {
                  id: id * 10 + 1,
                  run_id: id,
                  name: "review / review",
                  status: "completed",
                  conclusion: options.preflightSkipped
                    ? "skipped"
                    : options.stale
                      ? "success"
                      : options.missing
                        ? "timed_out"
                        : "success",
                  completed_at: "2026-09-11T00:10:40Z",
                  steps: [
                    {
                      name: "Classify canonical state",
                      number: 9,
                      conclusion: "success",
                      status: "completed",
                    },
                    {
                      name: "Run actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
                      number: 10,
                      conclusion: options.stale ? "skipped" : "success",
                      status: "completed",
                    },
                  ],
                },
                {
                  id: id * 10 + 2,
                  run_id: id,
                  name: "review / publisher",
                  status: "completed",
                  conclusion: options.failedPublisher?.includes(id) ? "failure" : "success",
                  completed_at: id === 1 ? "2026-09-11T00:11:00Z" : "2026-09-11T00:15:00Z",
                  steps: [],
                },
              ],
            });
          return response({
            ...run(id),
            ...(match[2]
              ? {
                  run_attempt: Number(match[2]),
                  run_started_at:
                    Number(match[2]) === 1
                      ? (options.runStart ?? "2026-09-11T00:00:30Z")
                      : "2026-09-11T00:20:00Z",
                }
              : {}),
          });
        }
        const download = /\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
        if (download)
          return new Response(
            new Uint8Array(
              options.corrupt
                ? strToU8("bad zip")
                : zipSync({
                    "ai-review-state-v1.json": strToU8(
                      JSON.stringify(states[Number(download[1]) - 1]),
                    ),
                  }),
            ),
            { headers: { "content-type": "application/zip" } },
          );
        if (path.endsWith("/pulls/17"))
          return response({
            head: {
              sha: options.oldHead || (options.changedHead && ++heads > 1) ? "e".repeat(40) : sha,
            },
          });
        if (path.endsWith("/issues/17/comments")) return response([summary]);
        if (path.endsWith("/issues/comments/70")) return response(summary);
        if (path.endsWith("/pulls/17/comments"))
          return response(
            states[0]!.findings.map((f) => ({
              id: 80,
              user: options.forgedBot ? human : bot,
              original_commit_id: sha,
              body: renderInlineFinding(sha, f),
              created_at: summary.created_at,
              updated_at: summary.updated_at,
            })),
          );
        if (path.endsWith("/reactions"))
          return response(
            options.conflict
              ? [reaction("+1"), reaction("-1")]
              : [reaction(options.reaction ?? "+1")],
          );
        if (path.endsWith("/collaborators/maintainer/permission"))
          return response({ permission: options.permission ?? "write" });
        if (path.endsWith("/issues/17/timeline"))
          return response(
            options.miss
              ? [
                  {
                    event: "commented",
                    id: 90,
                    user: human,
                    actor: human,
                    body: options.miss,
                    created_at: "2026-09-11T00:13:00Z",
                    updated_at: "2026-09-11T00:13:00Z",
                  },
                ]
              : [],
          );
        throw new Error(`Unexpected GET ${path}`);
      },
    },
  });
  return { octokit, paths };
}

describe("read-only GitHub calibration collection", () => {
  it("reads trusted canonical artifacts, labels, timelines and primary-CI timing", async () => {
    const { octokit, paths } = github({ states: [canonical("BLOCK")] });
    const result = await collectCalibration(octokit, "o/r", 0);
    expect(result.report).toMatchObject({
      completed_live_reviews: 1,
      evaluated_blocking_cases: 1,
      false_block_rate: 0,
      blocking_finding_precision: 1,
      p95_latency_ms: 660000,
    });
    expect(paths).toContain("/repos/o/r/issues/17/timeline");
  });
  it("deduplicates reused artifacts while retaining preflight UNABLE attempts", async () => {
    const result = await collectCalibration(
      github({ states: [canonical(), canonical(), canonical("UNABLE_TO_REVIEW")] }).octokit,
      "o/r",
      0,
    );
    expect(result.report).toMatchObject({
      completed_live_reviews: 1,
      completed_review_rate: 0.5,
      unable_rate: 0.5,
    });
    expect(result.coverage.reused_artifacts).toBe(1);
  });
  it.each([
    { permission: "read" },
    { conflict: true },
    { oldReaction: true },
    { forgedBot: true },
    { oldHead: true },
  ])("ignores untrusted, ambiguous or old-head summary feedback %j", async (options) => {
    expect(
      (
        await collectCalibration(
          github({ states: [canonical("BLOCK")], ...options }).octokit,
          "o/r",
          0,
        )
      ).report.false_block_rate,
    ).toBeNull();
  });
  it.each(["write", "maintain", "admin"])(
    "counts an explicit %s maintainer PASS miss",
    async (permission) => {
      const result = await collectCalibration(
        github({ permission, miss: `<!-- ai-pr-review-material-miss:v1:${sha} -->` }).octokit,
        "o/r",
        0,
      );
      expect(result.report.material_miss_rate).toBe(1);
    },
  );
  it.each(["human found blocker", `<!-- ai-pr-review-material-miss:v1:${"e".repeat(40)} -->`])(
    "never interprets discussion as a miss",
    async (miss) => {
      expect(
        (await collectCalibration(github({ miss, reaction: "-1" }).octokit, "o/r", 0)).report
          .material_miss_rate,
      ).toBe(0);
    },
  );
  it("counts missing failed attempts conservatively", async () => {
    const result = await collectCalibration(github({ missing: true }).octokit, "o/r", 0);
    expect(result.report.unable_rate).toBe(1);
    expect(result.coverage.missing_attempts).toBe(1);
  });
  it.each([{ stale: true }, { preflightSkipped: true }])(
    "excludes deterministic skipped attempts %j",
    async (options) => {
      const result = await collectCalibration(
        github({ missing: true, ...options }).octokit,
        "o/r",
        0,
      );
      expect(result.report.unable_rate).toBe(0);
      expect(result.coverage.excluded_runs).toBe(1);
    },
  );
  it("accounts for prior run attempts rather than losing failed reruns", async () => {
    const result = await collectCalibration(github({ rerun: true }).octokit, "o/r", 0);
    expect(result.report).toMatchObject({ completed_live_reviews: 1, unable_rate: 0.5 });
  });
  it("does not turn expired artifacts or missing CI evidence into perfect metrics", async () => {
    expect(
      (await collectCalibration(github({ expired: true }).octokit, "o/r", 0)).report.unable_rate,
    ).toBe(1);
    expect(
      (await collectCalibration(github({ ciMissing: true }).octokit, "o/r", 0)).report
        .p95_latency_ms,
    ).toBeNull();
  });
  it("ignores forged origins without downloading", async () => {
    const { octokit, paths } = github({ untrusted: true });
    expect((await collectCalibration(octokit, "o/r", 0)).report.completed_live_reviews).toBe(0);
    expect(paths.some((p) => p.endsWith("/zip"))).toBe(false);
  });
  it("fails closed on retained corrupt state and concurrent head changes", async () => {
    await expect(collectCalibration(github({ corrupt: true }).octokit, "o/r", 0)).rejects.toThrow();
    await expect(
      collectCalibration(github({ changedHead: true }).octokit, "o/r", 0),
    ).rejects.toThrow();
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { runCli, renderCalibration } from "../../src/cli/calibration-report.js";

it("prints every criterion, cost soft alerts, observation coverage and mandatory owner approval", () => {
  const result = {
    report: buildCalibrationReport(
      "o/r",
      ready().map((s) => ({ ...s, costUsd: 3 })),
      0,
    ),
    coverage: {
      window_start: "2026-06-13T01:00:00.000Z",
      window_end: "2026-09-11T01:00:00.000Z",
      trusted_terminal_attempts: 25,
      canonical_attempts: 25,
      reused_artifacts: 0,
      missing_attempts: 0,
      excluded_runs: 0,
      pending_runs: 0,
      latency_observations: 25,
      cost_observations: 25,
    },
  };
  const text = renderCalibration(result);
  expect(text.match(/\| PASS \|/g)).toHaveLength(9);
  expect(text).toContain("median cost exceeds $1.00");
  expect(text).toContain("p95 cost exceeds $2.00");
  expect(text).toContain("not an audit");
  expect(text).toContain("Missing attempted reviews: 0");
  expect(
    text
      .trimEnd()
      .endsWith("Engineering-owner approval is still required before changing required checks."),
  ).toBe(true);
});

it("CLI reads GitHub and emits only report fields in an optional JSON file", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-11T01:00:00Z"));
  const directory = await mkdtemp(join(tmpdir(), "calibration-"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const output = join(directory, "report.json");
    expect(
      await runCli(
        ["--repository", "o/r", "--json-out", output, "--known-security-boundary-violations", "2"],
        {},
        () => github().octokit,
      ),
    ).toBe(0);
    const saved = JSON.parse(await readFile(output, "utf8"));
    expect(saved.completed_live_reviews).toBe(1);
    expect(saved.known_security_boundary_violations).toBe(2);
    expect(Object.keys(saved)).toHaveLength(15);
    expect(log.mock.calls.flat().join("\n")).toContain("Engineering-owner approval");
  } finally {
    log.mockRestore();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

const invalidArguments: string[][] = [
  [],
  ["--repository", "bad/repo/extra"],
  ["--repository", "o/r", "--known-security-boundary-violations", "-1"],
  ["--repository", "o/r", "--known-security-boundary-violations", "1.5"],
];
for (const args of invalidArguments) {
  it("CLI rejects invalid arguments safely", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await runCli(args, {}, () => {
          throw new Error("private-token-canary");
        }),
      ).toBe(70);
      expect(error.mock.calls.flat().join("\n")).toBe("CALIBRATION_REPORT_FAILED");
    } finally {
      error.mockRestore();
    }
  });
}

it("CLI owns a quiet Octokit transport and never exposes authenticated request failures", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ message: "private-token-canary" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-github-request-id": "request-canary" },
    }),
  );
  try {
    expect(await runCli(["--repository", "o/r"], { GITHUB_TOKEN: "private-token-canary" })).toBe(
      70,
    );
    expect(error.mock.calls.flat().join("\n")).toBe("CALIBRATION_REPORT_FAILED");
  } finally {
    error.mockRestore();
    fetch.mockRestore();
  }
});

it("uses earliest successful publication across reuse and publisher recovery", async () => {
  const states = [canonical(), canonical()];
  expect(
    (await collectCalibration(github({ states }).octokit, "o/r", 0)).report.p95_latency_ms,
  ).toBe(660000);
  expect(
    (await collectCalibration(github({ states, failedPublisher: [1] }).octokit, "o/r", 0)).report
      .p95_latency_ms,
  ).toBe(900000);
  expect(
    (await collectCalibration(github({ states, failedPublisher: [1, 2] }).octokit, "o/r", 0)).report
      .p95_latency_ms,
  ).toBeNull();
});
it("limits observation to 90 days by attempt start, including reruns of old runs", async () => {
  const old = { createdAt: "2025-01-01T00:00:00Z" };
  expect(
    (await collectCalibration(github(old).octokit, "o/r", 0)).report.completed_live_reviews,
  ).toBe(1);
  const result = await collectCalibration(
    github({ ...old, runStart: "2025-01-01T00:00:00Z", rerun: true }).octokit,
    "o/r",
    0,
  );
  expect(result.coverage.trusted_terminal_attempts).toBe(1);
  expect(result.coverage.window_end).toBe("2026-09-11T01:00:00.000Z");
});
it("fails closed on incomplete pagination", async () => {
  await expect(
    collectCalibration(github({ incomplete: true }).octokit, "o/r", 0),
  ).rejects.toThrow();
});
