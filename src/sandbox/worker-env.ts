import { mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { assertCreatablePathContained, assertRealpathContained } from "./path-containment.js";

export async function buildWorkerEnv(
  input: { reviewRoot: string; runtimeDir: string },
  parent: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const { reviewRoot: root, runtimeDir: runtime } = input;
  if (!/^sk-sp-[A-Za-z0-9._-]+$/.test(parent.QWEN_TOKEN_PLAN_API_KEY ?? ""))
    throw new Error("PROVIDER_CONFIG_INVALID");
  if (
    !isAbsolute(root) ||
    !isAbsolute(runtime) ||
    root === runtime ||
    dirname(root) !== dirname(runtime)
  )
    throw new Error("RUNTIME_MUST_BE_SIBLING");
  const canonicalRoot = await realpath(root),
    canonicalRuntime = await realpath(runtime);
  if (canonicalRoot === canonicalRuntime || dirname(canonicalRoot) !== dirname(canonicalRuntime))
    throw new Error("RUNTIME_MUST_BE_SIBLING");
  for (const name of ["home", "xdg", "pi-agent", "tmp", "bin"]) {
    const path = await assertCreatablePathContained(runtime, join(runtime, name));
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertRealpathContained(runtime, path);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ]) {
    if (parent[name] !== undefined) env[name] = parent[name];
  }
  return {
    ...env,
    PATH: join(runtime, "bin") + (parent.PATH ? delimiter + parent.PATH : ""),
    HOME: join(runtime, "home"),
    XDG_CONFIG_HOME: join(runtime, "xdg"),
    PI_CODING_AGENT_DIR: join(runtime, "pi-agent"),
    TMPDIR: join(runtime, "tmp"),
    AI_PR_REVIEW_ROOT: root,
    AI_PR_REVIEW_RUNTIME: runtime,
    QWEN_TOKEN_PLAN_API_KEY: parent.QWEN_TOKEN_PLAN_API_KEY,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}
