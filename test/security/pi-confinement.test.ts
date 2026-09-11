import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { loadPiFilesystemTools } from "../../src/sandbox/pi-confinement-contract.js";

const denied = /^ACCESS_DENIED_OUTSIDE_REVIEW_ROOT:/;
let fixture: string;
let root: string;
let outside: string;
let secret: string;
const variants = [
  ["Screenshot 1 AM.txt", "Screenshot 1\u202fAM.txt"],
  ["caf\u00e9.txt", "cafe\u0301.txt"],
  ["Capture d'ecran.txt", "Capture d\u2019ecran.txt"],
  ["Capture d'\u00e9cran.txt", "Capture d\u2019e\u0301cran.txt"],
] as const;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-confinement-"));
  root = join(fixture, "root");
  outside = join(fixture, "outside");
  secret = join(outside, "secret.txt");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "inside control");
  await writeFile(secret, "OUTSIDE_CANARY_MUST_NOT_LEAK");
  await mkdir(join(root, "safe"));
  for (const [, actual] of variants) await writeFile(join(root, "safe", actual), "safe fallback");
});
let links: Promise<void> | undefined;
function prepareLinks(): Promise<void> {
  return (links ??= (async () => {
    await symlink(secret, join(root, "link"), "file");
    await symlink(outside, join(root, "linked-dir"), "junction");
    await symlink(join(outside, "missing"), join(root, "dangling"), "file");
    for (const [, actual] of variants) await symlink(secret, join(root, actual), "file");
  })());
}
afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv("AI_PR_REVIEW_ROOT", root);
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(() => vi.unstubAllEnvs());

async function runTool(name: "read" | "grep" | "find" | "ls", path: string, cwd = root) {
  const tools = await loadPiFilesystemTools(cwd);
  return tools[name].execute(
    "probe",
    { path, pattern: name === "grep" ? "CANARY" : "*" },
    undefined,
    undefined,
    { cwd },
  );
}
describe("real exported Pi tool confinement", () => {
  for (const tool of ["read", "grep", "find", "ls"] as const) {
    it(`${tool} rejects absolute outside paths`, async () => {
      await expect(runTool(tool, tool === "read" ? secret : outside)).rejects.toThrow(denied);
    });
    it(`${tool} rejects traversal`, async () => {
      await expect(
        runTool(tool, tool === "read" ? "../outside/secret.txt" : "../outside"),
      ).rejects.toThrow(denied);
    });
    it(`${tool} rejects symlink escapes`, async () => {
      await prepareLinks();
      await expect(runTool(tool, tool === "read" ? "link" : "linked-dir")).rejects.toThrow(denied);
    });
    it(`${tool} rejects missing children beneath escaping symlinks`, async () => {
      await prepareLinks();
      await expect(runTool(tool, "linked-dir/missing/child")).rejects.toThrow(denied);
    });
    it(`${tool} rejects an outside cwd even for an inside absolute candidate`, async () => {
      await expect(runTool(tool, join(root, "inside.txt"), outside)).rejects.toThrow(denied);
    });
  }
  it("read rejects a dangling symlink", async () => {
    await prepareLinks();
    await expect(runTool("read", "dangling")).rejects.toThrow(denied);
  });
  for (const [requested] of variants) {
    it(`read rejects escaping fallback ${requested}`, async () => {
      await prepareLinks();
      await expect(runTool("read", requested)).rejects.toThrow(denied);
    });
  }
  it("sync read resolver also rejects fallback escapes", async () => {
    await prepareLinks();
    const url = new URL(
      "core/tools/path-utils.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const resolver = (await import(url)) as {
      resolveReadPath: (path: string, cwd: string) => string;
    };
    for (const [requested] of variants)
      expect(() => resolver.resolveReadPath(requested, root)).toThrow(denied);
  });
  it.runIf(existsSync("/proc/self/environ"))("rejects Linux process environment", async () => {
    const outcome = await runTool("read", "/proc/self/environ").then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : "non-error rejection"),
    );
    expect(outcome).toMatch(denied);
  });
  for (const [requested] of variants) {
    it(`preserves safe fallback ${requested}`, async () => {
      expect(JSON.stringify(await runTool("read", `safe/${requested}`))).toContain("safe fallback");
    });
  }
  it("preserves valid in-root normalization", async () => {
    expect(JSON.stringify(await runTool("read", "@inside.txt"))).toContain("inside control");
  });
  it("preserves upstream behavior without the review-root environment variable", async () => {
    vi.stubEnv("AI_PR_REVIEW_ROOT", undefined);
    expect(JSON.stringify(await runTool("read", "inside.txt"))).toContain("inside control");
    expect(JSON.stringify(await runTool("read", secret))).toContain("OUTSIDE_CANARY_MUST_NOT_LEAK");
  });
});

describe("central containment contracts", () => {
  it("checks lexical boundaries without rejecting similarly named in-root files", async () => {
    const { assertLexicallyContained: check } =
      await import("../../src/sandbox/path-containment.js");
    expect(check(root, "inside.txt")).toBe(join(root, "inside.txt"));
    expect(() => check(root, "bad\0path")).toThrow(denied);
    expect(check(root, "..safe/file")).toBe(join(root, "..safe/file"));
    expect(() => check(root, "../outside/secret.txt")).toThrow(denied);
    expect(() => check(root, `${root}-sibling/secret.txt`)).toThrow(denied);
  });
  it("checks real paths and preserves filesystem errors", async () => {
    await prepareLinks();
    const { assertRealpathContained: check } =
      await import("../../src/sandbox/path-containment.js");
    expect(await check(root, "inside.txt")).toBe(await realpath(join(root, "inside.txt")));
    await expect(check(root, secret)).rejects.toThrow(denied);
    await expect(check(root, "link")).rejects.toThrow(denied);
    await expect(check(root, "missing")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks nearest existing parents for creatable paths, including dangling links", async () => {
    await prepareLinks();
    const { assertCreatablePathContained: check } =
      await import("../../src/sandbox/path-containment.js");
    expect(await check(root, "new/child.txt")).toBe(join(root, "new/child.txt"));
    await expect(check(root, "../outside/new")).rejects.toThrow(denied);
    await expect(check(root, "linked-dir/new/child")).rejects.toThrow(denied);
    await expect(check(root, "dangling/child")).rejects.toThrow(denied);
  });
  it("runtime probe verifies the actual patched tools and rejects missing/mismatched configuration", async () => {
    const { assertPiConfinementContract: check } =
      await import("../../src/sandbox/pi-confinement-contract.js");
    await expect(check(root)).resolves.toBeUndefined();
    vi.stubEnv("AI_PR_REVIEW_ROOT", outside);
    await expect(check(root)).rejects.toThrow("PI_CONFINEMENT_CONTRACT_FAILED");
    vi.stubEnv("AI_PR_REVIEW_ROOT", undefined);
    await expect(check(root)).rejects.toThrow("PI_CONFINEMENT_CONTRACT_FAILED");
  });
});
