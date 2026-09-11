import { Octokit } from "@octokit/rest";
import { expect, it } from "vitest";
import { createGitHubPublisher } from "../../src/github/publisher.js";

const bot = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const head = "b".repeat(40);
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
it("paginates all check and comment surfaces and excludes forged ownership", async () => {
  const reads: string[] = [];
  const octokit = new Octokit({
    auth: "fake-write-token",
    request: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        reads.push(url.pathname + url.search);
        const page = Number(url.searchParams.get("page"));
        if (url.pathname.endsWith("/check-runs")) {
          expect(url.searchParams.get("filter")).toBe("all");
          const checks =
            page === 1
              ? Array.from({ length: 100 }, (_, id) => ({
                  id,
                  name: "AI PR Review",
                  external_id: "other",
                  head_sha: head,
                  app: { id: 99, slug: "forged" },
                }))
              : [
                  {
                    id: 101,
                    name: "AI PR Review",
                    external_id: "expected",
                    head_sha: head,
                    app: { id: 15368, slug: "github-actions" },
                  },
                ];
          return json({ total_count: 101, check_runs: checks });
        }
        const comment = { id: 101, body: "owned", user: bot, original_commit_id: head };
        return json(
          page === 1
            ? Array.from({ length: 100 }, (_, id) => ({ ...comment, id, user: { ...bot, id: 99 } }))
            : [
                comment,
                { ...comment, id: 102, user: { ...bot, type: "User" } },
                { ...comment, id: 103, user: { ...bot, login: "other[bot]" } },
              ],
        );
      },
    },
  });
  const publisher = createGitHubPublisher(octokit);
  expect(await publisher.listChecks("o/r", head)).toEqual([
    { id: 101, name: "AI PR Review", external_id: "expected", head_sha: head },
  ]);
  expect(await publisher.listSummaries("o/r", 17)).toEqual([{ id: 101, body: "owned" }]);
  expect(await publisher.listInline("o/r", 17)).toEqual([
    { id: 101, body: "owned", original_commit_id: head },
  ]);
  expect(reads).toHaveLength(6);
});
it("uses exact-head check payloads, issue comments and COMMENT-only reviews on real Octokit transport", async () => {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const publisher = createGitHubPublisher(
    new Octokit({
      auth: "fake-write-token",
      request: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (init?.method === "GET") return json({ head: { sha: head } });
          writes.push({
            method: init?.method ?? "",
            path: url.pathname,
            body: JSON.parse(String(init?.body)),
          });
          return json({ id: 42 });
        },
      },
    }),
  );
  expect(await publisher.getHead("o/r", 17)).toBe(head);
  const check = {
    name: "AI PR Review",
    head_sha: head,
    external_id: "identity",
    status: "completed",
    conclusion: "failure",
    output: { title: "AI PR Review", summary: "Outcome: BLOCK" },
  } as const;
  await publisher.writeCheck("o/r", check);
  await publisher.writeCheck("o/r", check, 42);
  await publisher.writeSummary("o/r", 17, "summary");
  await publisher.writeSummary("o/r", 17, "changed", 7);
  await publisher.writeInline("o/r", 17, head, [
    { path: "src/a.ts", line: 7, side: "RIGHT", body: "finding" },
  ]);
  expect(writes).toEqual([
    { method: "POST", path: "/repos/o/r/check-runs", body: check },
    {
      method: "PATCH",
      path: "/repos/o/r/check-runs/42",
      body: {
        name: "AI PR Review",
        external_id: "identity",
        status: "completed",
        conclusion: "failure",
        output: check.output,
      },
    },
    { method: "POST", path: "/repos/o/r/issues/17/comments", body: { body: "summary" } },
    { method: "PATCH", path: "/repos/o/r/issues/comments/7", body: { body: "changed" } },
    {
      method: "POST",
      path: "/repos/o/r/pulls/17/reviews",
      body: {
        commit_id: head,
        event: "COMMENT",
        comments: [{ path: "src/a.ts", line: 7, side: "RIGHT", body: "finding" }],
      },
    },
  ]);
});
it("does not hide an uncertain write with an automatic blind transport retry", async () => {
  let calls = 0;
  const diagnostics: unknown[][] = [];
  const publisher = createGitHubPublisher(
    new Octokit({
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args: unknown[]) => {
          diagnostics.push(args);
        },
      },
      request: {
        fetch: async () => {
          calls++;
          return new Response('{"message":"private canary"}', {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        },
      },
    }),
  );
  await expect(publisher.writeSummary("o/r", 17, "summary")).rejects.toBeDefined();
  expect(calls).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]![0]).toMatch(/^POST \/repos\/o\/r\/issues\/17\/comments - 503 /);
  expect(JSON.stringify(diagnostics)).not.toContain("private canary");
});

it("rejects incomplete check discovery instead of assuming the check is absent", async () => {
  const publisher = createGitHubPublisher(
    new Octokit({ request: { fetch: async () => json({ total_count: 2, check_runs: [] }) } }),
  );
  await expect(publisher.listChecks("o/r", head)).rejects.toThrow(
    "Incomplete GitHub checks response",
  );
});
