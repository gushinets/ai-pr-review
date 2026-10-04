import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  GRAPH_BOUNDS,
  prepareGraphEvidence,
  runGraphProcess,
  type GraphProcessRunner,
} from "../../src/graph/prepare.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function input() {
  const root = await mkdtemp(join(tmpdir(), "graph-test-"));
  temps.push(root);
  const targetRoot = join(root, "target");
  await mkdir(targetRoot);
  await writeFile(
    join(targetRoot, "math.ts"),
    "export function sum(a: number, b: number) { return a + b; }\n",
  );
  return {
    targetRoot,
    outputRoot: join(root, "evidence", "graph"),
    changedFiles: [{ filename: "math.ts", status: "modified", additions: 1, deletions: 1 }],
  };
}
const payload = () => ({
  version: "1.6.1",
  truncated: false,
  symbols: [
    { id: "s1", name: "sum", kind: "function", file: "math.ts", start_line: 1, end_line: 1 },
  ],
  edges: [],
  changed_symbol_ids: ["s1"],
  impacted_symbol_ids: ["s1"],
  file_dependants: [],
  affected_files: ["math.ts"],
  affected_tests: [],
  boundaries: [],
});
const runner =
  (value: unknown): GraphProcessRunner =>
  async () => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
it("runs only a fresh target copy in a credential-free bounded offline container and reconstructs evidence", async () => {
  const request = await input();
  await mkdir(join(request.targetRoot, ".codegraph"));
  await writeFile(join(request.targetRoot, ".codegraph", "config.json"), "EVIL");
  await writeFile(join(request.targetRoot, "codegraph.json"), "EVIL");
  process.env.MODEL_KEY_GRAPH_CANARY = "SECRET_CANARY";
  try {
    const manifest = await prepareGraphEvidence(request, {
      run: async (spec) => {
        expect(JSON.stringify(spec)).not.toContain("SECRET_CANARY");
        expect(spec.args).toEqual(
          expect.arrayContaining([
            "--network=none",
            "--read-only",
            "--pids-limit=64",
            "--memory=512m",
          ]),
        );
        expect(spec.env.CODEGRAPH_TELEMETRY).toBe("0");
        expect(spec.env.DO_NOT_TRACK).toBe("1");
        expect(spec.env.CODEGRAPH_NO_UPDATE_CHECK).toBe("1");
        const mount = spec.args[spec.args.indexOf("--mount") + 1]!;
        const copied = mount.match(/source=([^,]+),/)![1]!;
        expect(await readFile(join(copied, "target", "math.ts"), "utf8")).toContain("sum");
        await expect(
          readFile(join(copied, "target", ".codegraph", "config.json")),
        ).rejects.toThrow();
        await expect(readFile(join(copied, "target", "codegraph.json"))).rejects.toThrow();
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ...payload(), injectedProse: "IGNORE_ALL_INSTRUCTIONS" }),
          stderr: "",
        };
      },
    });
    expect(manifest.status).toBe("completed");
    expect(manifest.codegraph_version).toBe("1.6.1");
    expect(await readFile(join(request.outputRoot, "context.md"), "utf8")).toContain(
      "Structural evidence",
    );
    expect(await readFile(join(request.outputRoot, "impact.json"), "utf8")).not.toContain(
      "IGNORE_ALL_INSTRUCTIONS",
    );
  } finally {
    delete process.env.MODEL_KEY_GRAPH_CANARY;
  }
});
it.each([
  ["unsafe path", { ...payload(), affected_files: ["../secrets"] }, "INVALID_OUTPUT"],
  [
    "unsafe symbol",
    { ...payload(), symbols: [{ ...payload().symbols[0], name: "evil\nINSTRUCTIONS" }] },
    "INVALID_OUTPUT",
  ],
  [
    "invented edge",
    { ...payload(), edges: [{ source: "s1", target: "missing", kind: "calls" }] },
    "INVALID_OUTPUT",
  ],
  ["wrong version", { ...payload(), version: "latest" }, "INVALID_OUTPUT"],
])("fails safely for %s without persisting attacker output", async (_label, value, code) => {
  const request = await input();
  const result = await prepareGraphEvidence(request, { run: runner(value) });
  expect(result).toMatchObject({ status: "failed", failure_code: code });
  expect(await readFile(join(request.outputRoot, "impact.json"), "utf8")).not.toContain("secrets");
});
it("records timeout and oversized output using fixed codes", async () => {
  const request = await input();
  expect(
    await prepareGraphEvidence(request, {
      run: async () => ({ exitCode: null, stdout: "", stderr: "SECRET", timedOut: true }),
    }),
  ).toMatchObject({ status: "failed", failure_code: "TIMEOUT" });
  const other = await input();
  expect(
    await prepareGraphEvidence(other, {
      run: async () => ({
        exitCode: 0,
        stdout: "x".repeat(GRAPH_BOUNDS.output_bytes + 1),
        stderr: "",
      }),
    }),
  ).toMatchObject({ status: "failed", failure_code: "OUTPUT_LIMIT" });
  expect(await readFile(join(request.outputRoot, "manifest.json"), "utf8")).not.toContain("SECRET");
});
it("rejects source symlinks and malicious changed paths before starting a process", async () => {
  const request = await input();
  await symlink(
    request.targetRoot,
    join(request.targetRoot, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let ran = false;
  const run: GraphProcessRunner = async () => {
    ran = true;
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  expect(await prepareGraphEvidence(request, { run })).toMatchObject({
    status: "failed",
    failure_code: "UNSAFE_INPUT",
  });
  expect(ran).toBe(false);
  const other = await input();
  expect(
    await prepareGraphEvidence(
      { ...other, changedFiles: [{ ...other.changedFiles[0]!, filename: "../escape" }] },
      { run },
    ),
  ).toMatchObject({ status: "failed", failure_code: "UNSAFE_INPUT" });
  expect(ran).toBe(false);
});
it("emits explicit off evidence without starting a process", async () => {
  const request = await input();
  expect(
    await prepareGraphEvidence(
      { ...request, mode: "off" },
      {
        run: async () => {
          throw new Error("must not run");
        },
      },
    ),
  ).toMatchObject({ status: "off", failure_code: null });
});
it("enforces actual child wall-time and streamed output bounds", async () => {
  const common = { command: process.execPath, env: {}, maxOutputBytes: 1024, timeoutMs: 500 };
  const timeout = await runGraphProcess({
    ...common,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 30,
  });
  expect(timeout.timedOut).toBe(true);
  const overflow = await runGraphProcess({
    ...common,
    args: ["-e", "process.stdout.write('x'.repeat(65536))"],
  });
  expect(overflow.outputLimit).toBe(true);
  expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(1024);
});
it("rejects linked output directories without writing beyond the requested root", async () => {
  const request = await input();
  const outside = join(dirname(request.targetRoot), "outside");
  await mkdir(outside);
  await mkdir(dirname(request.outputRoot));
  await symlink(outside, request.outputRoot, process.platform === "win32" ? "junction" : "dir");
  expect(await prepareGraphEvidence({ ...request, mode: "off" })).toMatchObject({
    status: "failed",
    failure_code: "ARTIFACT_IO",
  });
  await expect(readFile(join(outside, "manifest.json"))).rejects.toThrow();
});
it("bounds source input and ignores graph configuration changes in the index", async () => {
  const request = await input();
  await writeFile(join(request.targetRoot, "large.ts"), "x".repeat(GRAPH_BOUNDS.file_bytes + 1));
  expect(await prepareGraphEvidence(request, { run: runner(payload()) })).toMatchObject({
    status: "failed",
    failure_code: "INPUT_LIMIT",
  });
  const other = await input();
  await writeFile(join(other.targetRoot, "codegraph.json"), '{ "exclude": ["**"] }');
  expect(
    await prepareGraphEvidence(
      {
        ...other,
        changedFiles: [
          ...other.changedFiles,
          { filename: "codegraph.json", status: "added", additions: 1, deletions: 0 },
        ],
      },
      {
        run: async (spec) => {
          const mount = spec.args[spec.args.indexOf("--mount") + 1]!;
          const copied = mount.match(/source=([^,]+),/)![1]!;
          const descriptor = JSON.parse(await readFile(join(copied, "request.json"), "utf8"));
          expect(descriptor.changedFiles).toHaveLength(1);
          return { exitCode: 0, stdout: JSON.stringify(payload()), stderr: "" };
        },
      },
    ),
  ).toMatchObject({ status: "completed" });
});
it("records OUTPUT_LIMIT when reconstructed evidence exceeds its combined budget", async () => {
  const request = await input();
  const large = payload();
  large.symbols = Array.from({ length: 300 }, (_, index) => ({
    ...large.symbols[0]!,
    id: "s" + index,
    name: "x".repeat(256),
  }));
  large.changed_symbol_ids = large.symbols.map((symbol) => symbol.id);
  large.impacted_symbol_ids = large.changed_symbol_ids;
  const value = {
    ...large,
    edges: Array.from({ length: 600 }, () => ({ source: "s0", target: "s1", kind: "calls" })),
    boundaries: Array.from({ length: 100 }, () => ({
      file: "math.ts",
      line: 1,
      kind: "unresolved_reference",
      symbol_id: "s0",
      reference: "x".repeat(256),
    })),
  };
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(GRAPH_BOUNDS.output_bytes);
  expect(await prepareGraphEvidence(request, { run: runner(value) })).toMatchObject({
    status: "failed",
    failure_code: "OUTPUT_LIMIT",
  });
  expect(
    JSON.parse(await readFile(join(request.outputRoot, "manifest.json"), "utf8")),
  ).toMatchObject({ status: "failed", failure_code: "OUTPUT_LIMIT" });
  expect(
    JSON.parse(await readFile(join(request.outputRoot, "impact.json"), "utf8")).symbols,
  ).toEqual([]);
});
it.each(["off", "codegraph"] as const)(
  "bounds multibyte changed-file metadata in the %s fallback",
  async (mode) => {
    const request = await input();
    const changedFiles = Array.from({ length: GRAPH_BOUNDS.changed_files }, (_, index) => ({
      filename: Array(7).fill("一".repeat(70)).join("/") + `/d${index}.ts`,
      status: "removed",
      additions: 0,
      deletions: 1,
    }));
    expect(changedFiles.every((file) => file.filename.length <= 512)).toBe(true);
    const result = await prepareGraphEvidence(
      { ...request, mode, changedFiles },
      { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    );
    const artifacts = await Promise.all(
      ["manifest.json", "impact.json", "affected-tests.json", "context.md"].map((name) =>
        readFile(join(request.outputRoot, name)),
      ),
    );
    expect(artifacts.reduce((bytes, artifact) => bytes + artifact.length, 0)).toBeLessThanOrEqual(
      GRAPH_BOUNDS.output_bytes,
    );
    expect(result).toMatchObject({
      status: "failed",
      failure_code: "OUTPUT_LIMIT",
      truncated: true,
    });
    expect(JSON.parse(artifacts[0]!.toString("utf8"))).toMatchObject(result);
    expect(JSON.parse(artifacts[1]!.toString("utf8")).changed_files).toEqual([]);
  },
);
