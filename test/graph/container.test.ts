import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareGraphEvidence } from "../../src/graph/prepare.js";

it.runIf(process.env.CODEGRAPH_CONTAINER_TEST === "1")(
  "builds real pinned graph evidence in the offline restricted Linux container",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-container-test-"));
    try {
      const targetRoot = join(root, "target");
      await cp(new URL("../../fixtures/graph/target/", import.meta.url), targetRoot, {
        recursive: true,
      });
      const outputRoot = join(root, "evidence", "graph");
      const changedFiles = [
        { filename: "math.ts", status: "modified", additions: 1, deletions: 1 },
        { filename: "dynamic.ts", status: "modified", additions: 1, deletions: 1 },
        { filename: "many.ts", status: "modified", additions: 1, deletions: 1 },
        { filename: "changed.test.ts", status: "modified", additions: 1, deletions: 1 },
        {
          filename: "renamed.ts",
          status: "renamed",
          previous_filename: "old-name.ts",
          additions: 0,
          deletions: 0,
        },
        { filename: "deleted.ts", status: "removed", additions: 0, deletions: 1 },
      ];
      const manifest = await prepareGraphEvidence({ targetRoot, outputRoot, changedFiles });
      expect(manifest).toMatchObject({
        status: "completed",
        failure_code: null,
        codegraph_version: "1.6.1",
      });
      const impact = JSON.parse(await readFile(join(outputRoot, "impact.json"), "utf8"));
      expect(impact.symbols.map((symbol: { name: string }) => symbol.name)).toEqual(
        expect.arrayContaining(["double", "serve", "entry"]),
      );
      expect(impact.affected_tests).toEqual(
        expect.arrayContaining(["changed.test.ts", "service.test.ts"]),
      );
      expect(impact.boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: "dynamic.ts", kind: "dynamic_dispatch" }),
          expect.objectContaining({ file: "many.ts", kind: "dynamic_dispatch" }),
        ]),
      );
      expect(impact.changed_files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filename: "deleted.ts", status: "removed" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
