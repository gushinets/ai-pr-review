import { Octokit } from "@octokit/rest";
import { expect, it } from "vitest";
import { createGitHubPublisher } from "../../src/github/publisher.js";

it("reconciles only comments and checks owned by the configured App", async () => {
  const user = { id: 1, login: "review-app[bot]", type: "Bot" };
  const octokit = new Octokit({
    request: {
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        const data = path.endsWith("check-runs")
          ? {
              total_count: 2,
              check_runs: [
                {
                  id: 1,
                  name: "AI PR Review",
                  external_id: "x",
                  head_sha: "a".repeat(40),
                  app: { id: 9, slug: "review-app" },
                },
                {
                  id: 2,
                  name: "AI PR Review",
                  external_id: "x",
                  head_sha: "a".repeat(40),
                  app: { id: 8, slug: "imposter" },
                },
              ],
            }
          : [
              { id: 1, body: "owned", user },
              { id: 2, body: "forged", user: { ...user, login: "imposter[bot]" } },
            ];
        return new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  const publisher = createGitHubPublisher(octokit, { appId: 9, botLogin: "review-app[bot]" });
  expect((await publisher.listChecks("o/r", "a".repeat(40))).map((c) => c.id)).toEqual([1]);
  expect(await publisher.listSummaries("o/r", 1)).toEqual([{ id: 1, body: "owned" }]);
});
