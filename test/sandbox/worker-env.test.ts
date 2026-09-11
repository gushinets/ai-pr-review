import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildWorkerEnv } from "../../src/sandbox/worker-env.js";
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function layout() {
  const dir = await mkdtemp(join(tmpdir(), "worker-env-"));
  temps.push(dir);
  const reviewRoot = join(dir, "review-root"),
    runtimeDir = join(dir, "runtime");
  await mkdir(reviewRoot);
  await mkdir(runtimeDir);
  return { reviewRoot, runtimeDir };
}
it("allowlists only operating values and Qwen, and overwrites all trusted runtime values", async () => {
  const input = await layout();
  const parent = {
    PATH: "safe-path",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
    NODE_EXTRA_CA_CERTS: "cert",
    HTTP_PROXY: "http://proxy",
    HTTPS_PROXY: "https://proxy",
    NO_PROXY: "localhost",
    QWEN_API_KEY: "qwen-canary",
    GITHUB_TOKEN: "github-canary",
    LINEAR_CLIENT_SECRET: "linear-canary",
    LINEAR_CLIENT_ID: "linear-id",
    AWS_SECRET_ACCESS_KEY: "aws-canary",
    NODE_OPTIONS: "--import evil",
    HOME: "/evil",
    PI_CODING_AGENT_DIR: "/evil",
    TMPDIR: "/evil",
    AI_PR_REVIEW_ROOT: "/evil",
    PI_OFFLINE: "0",
  };
  const env = await buildWorkerEnv(input, parent);
  expect(env).toEqual({
    PATH: join(input.runtimeDir, "bin") + delimiter + "safe-path",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
    NODE_EXTRA_CA_CERTS: "cert",
    HTTP_PROXY: "http://proxy",
    HTTPS_PROXY: "https://proxy",
    NO_PROXY: "localhost",
    QWEN_API_KEY: "qwen-canary",
    HOME: join(input.runtimeDir, "home"),
    XDG_CONFIG_HOME: join(input.runtimeDir, "xdg"),
    PI_CODING_AGENT_DIR: join(input.runtimeDir, "pi-agent"),
    TMPDIR: join(input.runtimeDir, "tmp"),
    AI_PR_REVIEW_ROOT: input.reviewRoot,
    AI_PR_REVIEW_RUNTIME: input.runtimeDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
  expect(JSON.stringify(env)).not.toMatch(
    /github-canary|linear-canary|linear-id|aws-canary|--import evil/,
  );
});
it("requires Qwen and sibling runtime, and rejects physically escaping runtime children", async () => {
  const input = await layout();
  await expect(buildWorkerEnv(input, {})).rejects.toThrow();
  await expect(
    buildWorkerEnv(
      { ...input, runtimeDir: join(input.reviewRoot, "runtime") },
      { QWEN_API_KEY: "k" },
    ),
  ).rejects.toThrow();
  await mkdir(join(input.reviewRoot, "hidden"));
  await symlink(join(input.reviewRoot, "hidden"), join(input.runtimeDir, "pi-agent"), "junction");
  await expect(buildWorkerEnv(input, { QWEN_API_KEY: "k" })).rejects.toThrow();
});
