import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../src/github/github-client.js";

const head = "a".repeat(40);
const check = (id: number) => ({
  id,
  name: `check-${id}`,
  head_sha: head,
  status: "completed",
  conclusion: "success",
  details_url: null,
  external_id: null,
  app: { id: 3 },
  output: { text: "PRIVATE" },
});
function client(fetch: typeof globalThis.fetch) {
  return createGitHubClient(
    new Octokit({
      request: { fetch },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }),
  );
}
function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

describe("evidence Octokit reads", () => {
  it("paginates exact-head checks, statuses and workflow jobs with normalized fields", async () => {
    const urls: URL[] = [];
    const github = client(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      urls.push(url);
      const page = Number(url.searchParams.get("page"));
      const ids = page === 1 ? Array.from({ length: 100 }, (_, id) => id + 1) : [101];
      if (url.pathname.endsWith("/check-runs")) {
        expect(url.pathname).toContain(`/commits/${head}/`);
        expect(url.searchParams.get("filter")).toBe("latest");
        return json({ total_count: 101, check_runs: ids.map(check) });
      }
      if (url.pathname.endsWith("/status")) {
        expect(url.pathname).toContain(`/commits/${head}/`);
        return json({
          sha: head,
          total_count: 101,
          statuses: ids.map((id) => ({
            id,
            context: `status-${id}`,
            state: "pending",
            target_url: null,
            description: "PRIVATE",
          })),
        });
      }
      if (url.pathname.endsWith("/runs")) {
        expect(url.searchParams.get("head_sha")).toBe(head);
        return json({ total_count: 1, workflow_runs: [{ id: 10, head_sha: head }] });
      }
      expect(url.pathname).toBe("/repos/o/r/actions/runs/10/jobs");
      return json({
        total_count: 101,
        jobs: ids.map((id) => ({
          id,
          run_id: 10,
          head_sha: head,
          check_run_url: `https://api.github.com/repos/o/r/check-runs/${id}`,
          name: "PRIVATE",
        })),
      });
    });
    const checks = await github.listCheckRuns("o/r", head);
    expect(checks).toHaveLength(101);
    expect(checks[100]).toEqual({
      id: 101,
      name: "check-101",
      headSha: head,
      status: "completed",
      conclusion: "success",
      detailsUrl: null,
      externalId: null,
      appId: 3,
    });
    const statuses = await github.getCommitStatuses("o/r", head);
    expect(statuses.sha).toBe(head);
    expect(statuses.statuses).toHaveLength(101);
    expect(statuses.statuses[100]).toEqual({
      id: 101,
      context: "status-101",
      state: "pending",
      targetUrl: null,
    });
    expect(await github.listWorkflowRuns("o/r", head)).toEqual([{ id: 10, headSha: head }]);
    expect((await github.listWorkflowJobs("o/r", 10))[100]).toEqual({
      id: 101,
      runId: 10,
      headSha: head,
      checkRunUrl: "https://api.github.com/repos/o/r/check-runs/101",
    });
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
      "2",
      "1",
      "1",
      "2",
    ]);
  });
  it("requests unified diff media and receives per-job plaintext logs", async () => {
    const github = client(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.method).toBe("GET");
      if (url.pathname.endsWith("/pulls/7")) {
        expect(new Headers(init?.headers).get("accept")).toContain("diff");
        return new Response("diff --git a/a b/a\n", { headers: { "content-type": "text/plain" } });
      }
      expect(url.pathname).toBe("/repos/o/r/actions/jobs/9/logs");
      return new Response("plaintext job log", { headers: { "content-type": "text/plain" } });
    });
    expect(await github.getPullRequestDiff("o/r", 7)).toBe("diff --git a/a b/a\n");
    expect(await github.downloadJobLog("o/r", 9)).toBe("plaintext job log");
  });
  it("rejects mismatched combined status SHA, including later pages", async () => {
    const github = client(async (input) => {
      const page = new URL(String(input)).searchParams.get("page");
      return json({
        sha: page === "1" ? head : "b".repeat(40),
        total_count: 101,
        statuses:
          page === "1"
            ? Array.from({ length: 100 }, (_, id) => ({
                id,
                context: `c${id}`,
                state: "pending",
                target_url: null,
              }))
            : [],
      });
    });
    await expect(github.getCommitStatuses("o/r", head)).rejects.toThrow();
  });
  it("rejects incomplete pagination instead of accepting truncated CI", async () => {
    const github = client(async () => json({ total_count: 101, check_runs: [] }));
    await expect(github.listCheckRuns("o/r", head)).rejects.toThrow();
  });
  it("rejects non-text diff and log responses", async () => {
    const github = client(async () => json({ content: "not plaintext" }));
    await expect(github.getPullRequestDiff("o/r", 7)).rejects.toThrow();
    await expect(github.downloadJobLog("o/r", 9)).rejects.toThrow();
  });
});
