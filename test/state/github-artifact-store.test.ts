import { crc32 } from "node:zlib";
import { Octokit } from "@octokit/rest";
import { strToU8, zipSync, Zip, ZipDeflate } from "fflate";
import { describe, expect, it } from "vitest";
import type { ReviewIdentityV1 } from "../../src/contracts/review-identity.js";
import type { ReviewStateV1 } from "../../src/contracts/review-state.js";
import { buildDiffIndex } from "../../src/github/diff.js";
import { buildReviewState } from "../../src/state/review-state.js";
import { GitHubArtifactStateStore } from "../../src/state/github-artifact-store.js";

const identity: ReviewIdentityV1 = {
  repository: "o/r",
  pr_number: 17,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  engine_sha: "c".repeat(40),
  linear_issue: "ANY-17",
};
const central = "gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml";
function state(
  change: Partial<ReviewIdentityV1> = {},
  outcome: ReviewStateV1["outcome"] = "PASS",
): ReviewStateV1 {
  const review = { ...identity, ...change };
  const { linear_issue, ...attempt } = review;
  return {
    schema_version: 1,
    attempt_identity: attempt,
    review_identity: review,
    lineage: { base_branch: "main", linear_issue },
    outcome,
    unable_reason: outcome === "UNABLE_TO_REVIEW" ? "STATE_LOAD_FAILED" : null,
    ci_summary: { head_sha: review.head_sha, primary_ci_workflow: "CI", checks: [] },
    judge_result:
      outcome === "UNABLE_TO_REVIEW"
        ? null
        : { schema_version: 1, summary: "Checked.", findings: [] },
    findings: [],
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
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function archive(value: unknown = state()) {
  return zipSync({ "ai-review-state-v1.json": strToU8(JSON.stringify(value)) });
}
function run(id: number, engine = identity.engine_sha) {
  return {
    id,
    event: "workflow_run",
    path: ".github/workflows/ai-pr-review.yml",
    head_branch: "main",
    head_sha: "f".repeat(40),
    status: "completed",
    conclusion: "failure",
    repository: { full_name: "o/r" },
    referenced_workflows: [{ path: `${central}@${engine}`, sha: engine, ref: `refs/heads/main` }],
  };
}
function artifact(id: number) {
  return {
    id,
    name: "ai-review-state-v1-pr-17",
    expired: false,
    size_in_bytes: 1000,
    created_at: `2026-09-11T00:${String(id % 60).padStart(2, "0")}:00Z`,
    workflow_run: {
      id,
      repository_id: 1,
      head_repository_id: 1,
      head_branch: "main",
      head_sha: "f".repeat(40),
    },
  };
}
interface Entry {
  id: number;
  value?: ReviewStateV1;
  bytes?: Uint8Array;
  artifact?: Partial<ReturnType<typeof artifact>>;
  run?: Partial<ReturnType<typeof run>>;
  status?: number;
}
function setup(entries: Entry[], listOverride?: unknown) {
  const requests: string[] = [];
  const octokit = new Octokit({
    request: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        expect(init?.method).toBe("GET");
        if (url.pathname === "/repos/o/r/actions/artifacts") {
          expect(url.searchParams.get("name")).toBe("ai-review-state-v1-pr-17");
          expect(url.searchParams.get("per_page")).toBe("100");
          const page = Number(url.searchParams.get("page"));
          return json(
            listOverride ?? {
              total_count: entries.length,
              artifacts: entries
                .slice((page - 1) * 100, page * 100)
                .map((entry) => ({ ...artifact(entry.id), ...entry.artifact })),
            },
          );
        }
        const match = /\/actions\/(runs|artifacts)\/(\d+)(\/zip)?$/.exec(url.pathname);
        if (!match) throw new Error(`Unexpected request ${url.pathname}`);
        const entry = entries.find((item) => item.id === Number(match[2]));
        if (!entry) throw new Error("Unknown fixture ID");
        if (match[1] === "runs")
          return json({ ...run(entry.id, entry.value?.attempt_identity.engine_sha), ...entry.run });
        expect(match[3]).toBe("/zip");
        if (entry.status) return json({ message: "download failed" }, entry.status);
        const bytes = entry.bytes ?? archive(entry.value);
        return new Response(new Uint8Array(bytes), {
          headers: { "content-type": "application/zip" },
        });
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { store: new GitHubArtifactStateStore(octokit, { defaultBranch: "main" }), requests };
}

describe("trusted canonical artifact discovery", () => {
  it.each(["PASS", "BLOCK"] as const)(
    "reuses an assembled %s under its exact safe base branch",
    async (outcome) => {
      const { schema_version: _, findings: _findings, ...input } = state({}, outcome);
      input.lineage.base_branch = "release/2026.09";
      input.judge_result!.summary = "linear-secret-456";
      if (outcome === "BLOCK")
        input.judge_result!.findings = [
          {
            severity: "blocking",
            confidence: "high",
            title: "Missing guard",
            location: null,
            basis: ["code"],
            evidence: "Unchecked input",
            rationale: "Can crash",
            remediation: "Validate input",
          },
        ];
      const saved = buildReviewState(
        input,
        { privateTexts: [], secretValues: ["linear-secret-456"] },
        buildDiffIndex(""),
      );
      expect(saved.judge_result!.summary).toBe("[REDACTED]");
      expect(
        await setup([{ id: 1, value: saved }]).store.load(identity, "release/2026.09"),
      ).toEqual({ kind: "reuse", state: saved });
    },
  );
  it.each(["PASS", "BLOCK"] as const)(
    "reuses exact identity %s despite failed presentation and different workflow head",
    async (outcome) => {
      const saved = state({}, outcome);
      const { store, requests } = setup([
        { id: 2, value: saved },
        { id: 1, bytes: strToU8("broken") },
      ]);
      expect(await store.load(identity, "main")).toEqual({ kind: "reuse", state: saved });
      expect(requests).not.toContain("/repos/o/r/actions/artifacts/1/zip");
    },
  );
  it("keeps UNABLE rerunnable and preserves older completed blocker history", async () => {
    const unable = state({}, "UNABLE_TO_REVIEW");
    const previous = state({ head_sha: "d".repeat(40), engine_sha: "e".repeat(40) }, "BLOCK");
    const { store } = setup([
      { id: 2, value: unable },
      { id: 1, value: previous },
    ]);
    expect(await store.load(identity, "main")).toEqual({
      kind: "fresh",
      previous,
      history: [previous],
      rerunnable: unable,
    });
  });
  it("finds an older exact completed identity behind a newer rerunnable attempt", async () => {
    const { store } = setup([
      { id: 3, value: state({}, "UNABLE_TO_REVIEW") },
      { id: 2, value: state() },
    ]);
    expect(await store.load(identity, "main")).toEqual({ kind: "reuse", state: state() });
  });
  it.each([{ repository: "other/r" }, { pr_number: 99 }, { linear_issue: "ANY-99" }])(
    "ignores valid JSON from an incompatible lineage %j",
    async (change) => {
      const { store } = setup([{ id: 1, value: state(change) }]);
      expect(await store.load(identity, "main")).toEqual({
        kind: "fresh",
        previous: null,
        history: [],
        rerunnable: null,
      });
    },
  );
  it("starts clean when the PR is retargeted", async () => {
    const { store } = setup([{ id: 1, value: state() }]);
    expect(await store.load(identity, "release")).toEqual({
      kind: "fresh",
      previous: null,
      history: [],
      rerunnable: null,
    });
  });
  it.each(["base_sha", "head_sha", "engine_sha"] as const)(
    "treats changed %s as fresh while preserving history",
    async (key) => {
      const previous = state({ [key]: "d".repeat(40) });
      expect(await setup([{ id: 1, value: previous }]).store.load(identity, "main")).toEqual({
        kind: "fresh",
        previous,
        history: [previous],
        rerunnable: null,
      });
    },
  );
  it("orders compatible history newest first independent of list order", async () => {
    const older = state({ head_sha: "d".repeat(40) });
    const newer = state({ head_sha: "e".repeat(40) });
    expect(
      await setup([
        { id: 1, value: older },
        { id: 2, value: newer },
      ]).store.load(identity, "main"),
    ).toEqual({ kind: "fresh", previous: newer, history: [newer, older], rerunnable: null });
  });
  it.each([404, 410])(
    "skips missing or expired downloads (%s), allowing fresh review",
    async (status) => {
      expect(await setup([{ id: 1, status }]).store.load(identity, "main")).toEqual({
        kind: "fresh",
        previous: null,
        history: [],
        rerunnable: null,
      });
    },
  );
  it("does not download expired or noncanonical artifacts", async () => {
    const { store, requests } = setup([
      { id: 1, artifact: { expired: true } },
      { id: 2, artifact: { name: "other" } },
    ]);
    expect(await store.load(identity, "main")).toEqual({
      kind: "fresh",
      previous: null,
      history: [],
      rerunnable: null,
    });
    expect(requests).toHaveLength(1);
  });
  it("paginates beyond one hundred artifacts", async () => {
    const entries: Entry[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      artifact: { expired: true },
    }));
    entries.push({ id: 101, value: state() });
    const { store, requests } = setup(entries);
    expect((await store.load(identity, "main")).kind).toBe("reuse");
    expect(requests.filter((path) => path.endsWith("/actions/artifacts"))).toHaveLength(2);
  });
  it.each([
    { event: "pull_request" },
    { path: ".github/workflows/ci.yml" },
    { head_branch: "attacker" },
    { referenced_workflows: [] },
    {
      referenced_workflows: [
        { path: `${central}@main`, sha: identity.engine_sha, ref: "refs/heads/main" },
      ],
    },
    {
      referenced_workflows: [
        {
          path: `attacker/r/.github/workflows/reusable.yml@${identity.engine_sha}`,
          sha: identity.engine_sha,
          ref: "refs/heads/main",
        },
      ],
    },
    {
      referenced_workflows: [
        { path: `${central}@${identity.engine_sha}`, sha: "e".repeat(40), ref: "refs/heads/main" },
      ],
    },
  ])("rejects forged artifact origin %j without downloading", async (runChange) => {
    const { store, requests } = setup([{ id: 1, run: runChange }]);
    expect(await store.load(identity, "main")).toEqual({
      kind: "fresh",
      previous: null,
      history: [],
      rerunnable: null,
    });
    expect(requests).not.toContain("/repos/o/r/actions/artifacts/1/zip");
  });
  it("accepts the maintainer workflow_dispatch path", async () => {
    expect(
      (await setup([{ id: 1, run: { event: "workflow_dispatch" } }]).store.load(identity, "main"))
        .kind,
    ).toBe("reuse");
  });
  it("fails closed when state engine disagrees with trusted workflow pin", async () => {
    await expect(
      setup([{ id: 1, run: run(1, "e".repeat(40)) }]).store.load(identity, "main"),
    ).rejects.toThrow("STATE_LOAD_FAILED");
  });
  it.each([
    strToU8("not a zip"),
    zipSync({ "ai-review-state-v1.json": strToU8("{broken") }),
    archive({ ...state(), prompt: "private" }),
    zipSync({ "../ai-review-state-v1.json": strToU8(JSON.stringify(state())) }),
    zipSync({ "folder/ai-review-state-v1.json": strToU8(JSON.stringify(state())) }),
    zipSync({
      "ai-review-state-v1.json": strToU8(JSON.stringify(state())),
      "extra.txt": strToU8("unexpected"),
    }),
    zipSync({}),
  ])("fails closed on malformed canonical ZIP or JSON", async (bytes) => {
    await expect(setup([{ id: 1, bytes }]).store.load(identity, "main")).rejects.toThrow(
      /^STATE_LOAD_FAILED$/,
    );
  });
  it("rejects a ZIP with a mismatched CRC even when JSON remains valid", async () => {
    const bytes = archive();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const centralOffset = view.getUint32(bytes.length - 6, true);
    view.setUint32(centralOffset + 16, 1234, true);
    await expect(setup([{ id: 1, bytes }]).store.load(identity, "main")).rejects.toThrow(
      "STATE_LOAD_FAILED",
    );
  });
  it("rejects incomplete listings instead of rerolling missing evidence", async () => {
    await expect(
      setup([], { total_count: 101, artifacts: [] }).store.load(identity, "main"),
    ).rejects.toThrow("STATE_LOAD_FAILED");
  });
  it("fails closed on unreadable retained state", async () => {
    await expect(setup([{ id: 1, status: 403 }]).store.load(identity, "main")).rejects.toThrow(
      /^STATE_LOAD_FAILED$/,
    );
  });
});

describe("archive integrity and multi-head history", () => {
  it("preserves H1 blocker evidence behind H2 closure-only BLOCK for H3", async () => {
    const h1 = state({ head_sha: "1".repeat(40) }, "BLOCK");
    const finding = {
      severity: "blocking" as const,
      confidence: "high" as const,
      title: "Missing guard",
      location: null,
      basis: ["code" as const],
      evidence: "Observed unchecked access",
      rationale: "Causes a crash",
      remediation: "Validate the input",
    };
    h1.judge_result!.findings = [finding];
    h1.findings = [
      { ...finding, finding_id: "finding-h1", source_index: 0, publication_location: null },
    ];
    const h2 = state({ head_sha: "2".repeat(40) }, "BLOCK");
    h2.previous_review_head_sha = h1.review_identity!.head_sha;
    h2.resolution_result = {
      schema_version: 1,
      resolutions: [
        {
          previous_finding_id: "finding-h1",
          status: "still_present",
          confidence: "high",
          current_location: null,
          evidence: "The guard is still absent",
        },
      ],
    };
    const result = await setup([
      { id: 1, value: h1 },
      { id: 2, value: h2 },
    ]).store.load(identity, "main");
    expect(result).toEqual({ kind: "fresh", previous: h2, history: [h2, h1], rerunnable: null });
  });
  it("accepts a streamed ZIP with the data descriptor used by artifact uploads", async () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, bytes) => {
      if (error) throw error;
      chunks.push(bytes);
    });
    const file = new ZipDeflate("ai-review-state-v1.json");
    zip.add(file);
    file.push(strToU8(JSON.stringify(state())), true);
    zip.end();
    expect(
      (await setup([{ id: 1, bytes: Buffer.concat(chunks) }]).store.load(identity, "main")).kind,
    ).toBe("reuse");
  });
  it.each([
    "symlink",
    "local CRC",
    "unlisted trailing member",
    "oversized member",
    "invalid UTF-8",
  ])("rejects %s", async (kind) => {
    let bytes = archive();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const directory = view.getUint32(bytes.length - 6, true);
    if (kind === "symlink") view.setUint32(directory + 38, 0xa1ff0000, true);
    if (kind === "local CRC") view.setUint32(14, 1234, true);
    if (kind === "oversized member") view.setUint32(directory + 24, 16 * 1024 * 1024 + 1, true);
    if (kind === "invalid UTF-8")
      bytes = zipSync({ "ai-review-state-v1.json": new Uint8Array([0xff]) });
    if (kind === "unlisted trailing member") {
      bytes = Buffer.concat([
        bytes.subarray(0, directory),
        new Uint8Array([1, 2, 3]),
        bytes.subarray(directory),
      ]);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
        bytes.length - 6,
        directory + 3,
        true,
      );
    }
    await expect(setup([{ id: 1, bytes }]).store.load(identity, "main")).rejects.toThrow(
      "STATE_LOAD_FAILED",
    );
  });
});

describe("bounded state reads", () => {
  it("rejects an oversized download before ZIP extraction", async () => {
    await expect(
      setup([{ id: 1, bytes: new Uint8Array(16 * 1024 * 1024 + 1) }]).store.load(identity, "main"),
    ).rejects.toThrow("STATE_LOAD_FAILED");
  });
  it.each([{ repository: "o/r/extra" }, { pr_number: 0 }, { head_sha: "bad" }])(
    "rejects invalid current identity before a request",
    async (change) => {
      const { store, requests } = setup([]);
      await expect(store.load({ ...identity, ...change }, "main")).rejects.toThrow(
        "STATE_LOAD_FAILED",
      );
      expect(requests).toEqual([]);
    },
  );
});

it("fails closed when retained artifact chronology is unavailable", async () => {
  const { store } = setup([{ id: 1 }], {
    total_count: 1,
    artifacts: [{ ...artifact(1), created_at: null }],
  });
  await expect(store.load(identity, "main")).rejects.toThrow("STATE_LOAD_FAILED");
});

describe("actual ZIP expansion bounds", () => {
  it.each([4096, 16 * 1024 * 1024 + 1])(
    "rejects forged state-prefix metadata with %s additional expanded bytes",
    async (extraBytes) => {
      const prefix = strToU8(JSON.stringify(state()));
      const bytes = zipSync({
        "ai-review-state-v1.json": Buffer.concat([prefix, new Uint8Array(extraBytes).fill(32)]),
      });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const directory = view.getUint32(bytes.length - 6, true);
      // Lie consistently in both headers: unzipSync otherwise returns just this valid prefix.
      view.setUint32(14, crc32(prefix), true);
      view.setUint32(22, prefix.length, true);
      view.setUint32(directory + 16, crc32(prefix), true);
      view.setUint32(directory + 24, prefix.length, true);
      await expect(setup([{ id: 1, bytes }]).store.load(identity, "main")).rejects.toThrow(
        "STATE_LOAD_FAILED",
      );
    },
  );
  it("rejects bytes after the deflate stream inside the declared compressed member", async () => {
    const original = archive();
    const originalView = new DataView(original.buffer, original.byteOffset, original.byteLength);
    const directory = originalView.getUint32(original.length - 6, true);
    const compressedSize = originalView.getUint32(18, true);
    const bytes = Buffer.concat([
      original.subarray(0, directory),
      new Uint8Array([1, 2, 3]),
      original.subarray(directory),
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(18, compressedSize + 3, true);
    view.setUint32(directory + 3 + 20, compressedSize + 3, true);
    view.setUint32(bytes.length - 6, directory + 3, true);
    await expect(setup([{ id: 1, bytes }]).store.load(identity, "main")).rejects.toThrow(
      "STATE_LOAD_FAILED",
    );
  });
});
