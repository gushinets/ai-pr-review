import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installGitDiffShim, selectUnifiedDiffPath } from "../../src/sandbox/git-diff-shim.js";
const first =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new é\n";
const renamed =
  "diff --git a/old b/name.ts b/new b/name.ts\nsimilarity index 100%\nrename from old b/name.ts\nrename to new b/name.ts\n";
const quoted =
  'diff --git "a/\\303\\251 space.ts" "b/\\303\\251 space.ts"\nold mode 100644\nnew mode 100755';
const diff = first + renamed + quoted;
const args = ["diff", "HEAD", "-M", "--no-color", "--ignore-submodules=all"];
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function layout() {
  const privateDir = await mkdtemp(join(tmpdir(), "shim-test-"));
  temps.push(privateDir);
  const root = join(privateDir, "review-root");
  const runtime = join(privateDir, "runtime");
  await mkdir(join(root, "diff"), { recursive: true });
  await writeFile(join(root, "diff/pr.diff"), diff);
  await writeFile(join(root, "diff/numstat.txt"), "1\t1\tsrc/a.ts\n");
  await writeFile(join(privateDir, "canary"), "OUTSIDE_CANARY");
  return { privateDir, root, runtime };
}
it("selects byte-identical complete sections by old/new file or directory, including Git quoting", () => {
  for (const [path, expected] of [
    ["src", first],
    ["./src/a.ts", first],
    ["old b", renamed],
    ["new b/name.ts", renamed],
    ["é space.ts", quoted],
    ["missing", ""],
  ])
    expect(selectUnifiedDiffPath(diff, path!)).toBe(expected);
});
it.each([
  "/etc/passwd",
  "../canary",
  "src/../canary",
  "bad\0path",
  "C:/secret",
  "bad\\path",
  "--output=canary",
  "",
])("rejects unsafe selector %s", (path) => {
  expect(() => selectUnifiedDiffPath(diff, path)).toThrow();
});
it("runs the executable with exact pinned Rejudge argv and never reads a selected host path", async () => {
  const { root, runtime, privateDir } = await layout();
  const shim = await installGitDiffShim(root, runtime);
  const run = (argv: string[]) =>
    spawnSync(
      process.platform === "win32" ? process.execPath : shim,
      process.platform === "win32" ? [shim, ...argv] : argv,
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, AI_PR_REVIEW_ROOT: root } },
    );
  for (const [argv, expected] of [
    [args, diff],
    [[...args, "--numstat"], "1\t1\tsrc/a.ts\n"],
    [[...args, "--", "src/a.ts"], first],
    [["ls-files", "--others", "--exclude-standard"], ""],
  ] as const) {
    const result = run([...argv]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  }
  for (const argv of [
    ["status"],
    ["diff", "main", ...args.slice(2)],
    [...args, "--stat"],
    [...args, "--", "../canary"],
    [...args, "--", join(privateDir, "canary")],
    [...args, "--", "--output=canary"],
    [...args, "--numstat", "extra"],
    ["ls-files", "--others", "--exclude-standard", "extra"],
  ]) {
    const result = run(argv);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("OUTSIDE_CANARY");
  }
  expect(await readFile(join(privateDir, "canary"), "utf8")).toBe("OUTSIDE_CANARY");
});
it("rejects runtime inside review root, a non-sibling runtime and a sibling symlink into it", async () => {
  const { root, runtime, privateDir } = await layout();
  await expect(installGitDiffShim(root, join(root, "runtime"))).rejects.toThrow();
  await expect(installGitDiffShim(root, join(privateDir, "other", "runtime"))).rejects.toThrow();
  await mkdir(join(root, "hidden"));
  await symlink(join(root, "hidden"), runtime, "junction");
  await expect(installGitDiffShim(root, runtime)).rejects.toThrow();
});
it("captures actual pinned Rejudge reviewer customTools before any model session starts", async () => {
  const { root, runtime } = await layout();
  await installGitDiffShim(root, runtime);
  await mkdir(join(root, ".rejudge"));
  await mkdir(join(runtime, "pi-agent"));
  await mkdir(join(runtime, "tmp"));
  await mkdir(join(runtime, "home"));
  await writeFile(
    join(root, ".rejudge/config.json"),
    JSON.stringify({ reviewers: ["test/one@high", "test/two@high"], judge: "test/judge@high" }),
  );
  const require = createRequire(import.meta.url);
  const extension = pathToFileURL(require.resolve("rejudge/dist/extension.js")).href;
  const pi = import.meta.resolve("@earendil-works/pi-coding-agent");
  const script = join(runtime, "capture.mjs");
  await writeFile(
    script,
    `
import {registerHooks} from 'node:module';
const extension=${JSON.stringify(extension)};
const pi=${JSON.stringify(pi)};
globalThis.captured=[];
const facade='data:text/javascript,'+encodeURIComponent(
 'export * from '+JSON.stringify(pi)+';'+
 'export const ModelRuntime={create:async()=>({getModel:(provider,id)=>({provider,id})})};'+
 'export async function createAgentSession(options){globalThis.captured.push(options);throw Error("CAPTURE_BEFORE_MODEL");}'
);
registerHooks({resolve(specifier,context,next){
 if(specifier==='@earendil-works/pi-coding-agent'&&context.parentURL===extension)return {url:facade,shortCircuit:true};
 return next(specifier,context);
}});
const {default:load}=await import(extension);
let tool;load({registerTool(value){tool=value;}});
await tool.execute('capture',{question:'Inspect inert evidence'},undefined,undefined,{cwd:process.env.AI_PR_REVIEW_ROOT});
process.stdout.write(JSON.stringify(globalThis.captured.map(options=>({tools:options.tools,customTools:options.customTools.map(tool=>({name:tool.name,execute:typeof tool.execute}))}))));
`,
  );
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    env: {
      PATH: process.env.PATH,
      AI_PR_REVIEW_ROOT: root,
      PI_CODING_AGENT_DIR: join(runtime, "pi-agent"),
      PI_OFFLINE: "1",
      HOME: join(runtime, "home"),
      USERPROFILE: join(runtime, "home"),
      XDG_CONFIG_HOME: join(runtime, "home"),
      TMPDIR: join(runtime, "tmp"),
      TEMP: join(runtime, "tmp"),
      TMP: join(runtime, "tmp"),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(
    Array.from({ length: 2 }, () => ({
      tools: ["read", "grep", "find", "ls", "git_diff"],
      customTools: [{ name: "git_diff", execute: "function" }],
    })),
  );
}, 20000);
