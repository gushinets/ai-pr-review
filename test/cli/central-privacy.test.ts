import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as appAuth from "../../src/app/github-app.js";
import { runCentralCli } from "../../src/cli/central.js";
import type { GithubReadClient } from "../../src/github/github-client.js";

const request = {
  schema_version: 2,
  repository: "owner/private-target",
  prNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  baseBranch: "main",
  trigger: { kind: "internal", actor: "owner" },
  requirementsSource: { kind: "none" },
  graphMode: "off",
  execution: "canonical",
};
const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "central-privacy-"));
  temps.push(directory);
  return {
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, "output"),
    ENGINE_SHA: "e".repeat(40),
    REVIEW_REQUEST: JSON.stringify(request),
    EXECUTION_REPOSITORY_PRIVATE: "true",
    STATE_READ_TOKEN: "central-read-canary",
    STATE_REPOSITORY: "operator/private-execution",
    STATE_DEFAULT_BRANCH: "main",
    GITHUB_WORKFLOW_REF:
      "operator/private-execution/.github/workflows/central-ai-pr-review.yml@refs/heads/main",
  };
}
it.each(["false", "", undefined])(
  "rejects unproven private execution (%s) before minting target credentials",
  async (proof) => {
    const env = await environment();
    const mint = vi.spyOn(appAuth, "mintInstallationToken").mockResolvedValue("fake-target-token");
    expect(
      await runCentralCli(["token-read"], {
        REVIEW_REQUEST: env.REVIEW_REQUEST,
        GITHUB_OUTPUT: env.GITHUB_OUTPUT,
        EXECUTION_REPOSITORY_PRIVATE: proof,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "fake-key",
      }),
    ).toBe(70);
    expect(mint).not.toHaveBeenCalled();
    await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
  },
);
it.each([
  ["public", { private: false, visibility: "public" }],
  ["internal", { private: true, visibility: "internal" }],
  ["missing visibility", { private: true }],
  ["wrong repository", { private: true, visibility: "private", full_name: "wrong/repo" }],
] as const)("rejects %s live execution metadata before target access", async (_name, metadata) => {
  const env = await environment();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ full_name: env.STATE_REPOSITORY, ...metadata }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const getPullRequest = vi.fn();
  const loadState = vi.fn();
  expect(
    await runCentralCli(["prepare"], env, {
      github: { getPullRequest } as unknown as GithubReadClient,
      loadState,
    }),
  ).toBe(70);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getPullRequest).not.toHaveBeenCalled();
  expect(loadState).not.toHaveBeenCalled();
  await expect(readFile(join(env.RUNNER_TEMP, "ai-pr-review/input.json"))).rejects.toThrow();
  await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
});
it.each([
  undefined,
  "wrong/repository/.github/workflows/custom.yml@refs/heads/main",
  "operator/private-execution/.github/workflows/custom.yml@refs/heads/other",
  "operator/private-execution/.github/workflows/custom.yml@refs/tags/main",
  "operator/private-execution/.github/workflows/../custom.yml@refs/heads/main",
  "operator/private-execution/.github/workflows/custom.txt@refs/heads/main",
])("rejects invalid workflow provenance %s before target access", async (workflowRef) => {
  const env = await environment();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ full_name: env.STATE_REPOSITORY, private: true, visibility: "private" }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const getPullRequest = vi.fn();
  expect(
    await runCentralCli(
      ["prepare"],
      { ...env, GITHUB_WORKFLOW_REF: workflowRef },
      { github: { getPullRequest } as unknown as GithubReadClient },
    ),
  ).toBe(70);
  expect(getPullRequest).not.toHaveBeenCalled();
  await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
});
it("rechecks visibility before canonical or shadow artifact upload", async () => {
  const env = await environment();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ full_name: env.STATE_REPOSITORY, private: false, visibility: "public" }),
      {
        headers: { "content-type": "application/json" },
      },
    ),
  );
  for (const execution of ["canonical", "shadow"] as const) {
    expect(
      await runCentralCli(["verify"], {
        ...env,
        REVIEW_REQUEST: JSON.stringify({ ...request, execution, experimentId: "private-shadow" }),
      }),
    ).toBe(70);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(readFile(env.GITHUB_OUTPUT)).rejects.toThrow();
});
