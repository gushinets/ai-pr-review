import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGraph } from "./runner.mjs";

// Trusted inert fixture only; this SDK check never imports or runs target source.
process.env.CODEGRAPH_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";
process.env.CODEGRAPH_NO_UPDATE_CHECK = "1";
process.env.CODEGRAPH_NO_DOWNLOAD = "1";
const temporary = await mkdtemp(join(tmpdir(), "graph-parser-test-"));
const changedFiles = [
  { filename: "math.ts", status: "modified" },
  { filename: "dynamic.ts", status: "modified" },
  { filename: "many.ts", status: "modified" },
  { filename: "changed.test.ts", status: "modified" },
  { filename: "renamed.ts", status: "renamed", previous_filename: "old-name.ts" },
  { filename: "deleted.ts", status: "removed" },
];
try {
  const target = join(temporary, "target");
  await cp(new URL("../fixtures/graph/target/", import.meta.url), target, { recursive: true });
  const bounds = {
    symbols: 300,
    edges: 600,
    boundaries: 100,
    files: 5000,
    depth: 5,
    output_bytes: 262144,
    dynamic_body_chars: 60000,
    dynamic_sites_per_symbol: 3,
  };
  const data = await collectGraph(target, {
    changedFiles,
    ranges: {},
    bounds,
  });
  const symbol = (name) => data.symbols.find((s) => s.name === name);
  assert(symbol("double"));
  assert(symbol("serve"));
  assert(symbol("entry"));
  assert(
    data.edges.some(
      (edge) =>
        edge.source === symbol("serve").id &&
        edge.target === symbol("double").id &&
        edge.kind === "calls",
    ),
  );
  assert(
    data.file_dependants.some(
      (dependant) => dependant.file === "math.ts" && dependant.dependant === "service.ts",
    ),
  );
  assert(
    data.edges.some(
      (edge) =>
        edge.source === symbol("entry").id &&
        edge.target === symbol("serve").id &&
        edge.kind === "calls",
    ),
  );
  assert(data.impacted_symbol_ids.includes(symbol("entry").id));
  assert(!symbol("unrelated"));
  assert(data.affected_tests.includes("changed.test.ts"));
  assert(data.affected_tests.includes("service.test.ts"));
  assert(symbol("renamed"));
  assert(!data.affected_files.includes("old-name.ts"));
  assert(!data.affected_files.includes("deleted.ts"));
  assert(
    data.boundaries.some(
      (boundary) => boundary.file === "dynamic.ts" && boundary.kind === "dynamic_dispatch",
    ),
  );
  assert(symbol("lateDispatch"));
  assert(
    data.boundaries.some(
      (boundary) => boundary.file === "many.ts" && boundary.kind === "dynamic_dispatch",
    ),
    "Dynamic dispatch after eight retained symbols must be scanned",
  );
  const largeTarget = join(temporary, "large-target");
  await mkdir(largeTarget);
  await writeFile(
    join(largeTarget, "large.ts"),
    `export function large(handlers: Record<string, () => void>, key: string): void {\n/*${"padding".repeat(10000)}*/\nhandlers[key]();\n}\n`,
  );
  const large = await collectGraph(largeTarget, {
    changedFiles: [{ filename: "large.ts", status: "modified" }],
    ranges: {},
    bounds,
  });
  assert(large.symbols.some((node) => node.name === "large"));
  assert(large.truncated, "An oversized symbol body must disclose incomplete boundary coverage");
  assert(
    !data.edges.some((edge) => edge.source === symbol("dispatch").id && edge.kind === "calls"),
  );
  console.log(
    "CodeGraph 1.6.1 parser fixture: callers, transitive impact, tests, rename/delete and dynamic boundaries verified.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
