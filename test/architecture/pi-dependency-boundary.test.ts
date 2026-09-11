import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

function isAllowedPiImporter(file: string): boolean {
  return /^src\/(review-engine|sandbox)\//.test(file.replaceAll("\\", "/"));
}

function violations(file: string, source: string): string[] {
  const failures: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith("@earendil-works/pi-") &&
      !isAllowedPiImporter(file)
    ) {
      failures.push(`${file}: ${specifier.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return failures;
}

it("limits Pi imports to approved runtime directories", () => {
  expect(isAllowedPiImporter("src/review-engine/rejudge-extension.ts")).toBe(true);
  expect(isAllowedPiImporter("src/sandbox/pi-confinement-contract.ts")).toBe(true);
  expect(isAllowedPiImporter("src/orchestration/review-pipeline.ts")).toBe(false);
  expect(isAllowedPiImporter("src/github/github-client.ts")).toBe(false);
  expect(isAllowedPiImporter("src/sandbox-other/escape.ts")).toBe(false);
  const file = "src/config/model-studio.ts";
  expect(
    violations(
      file,
      `import type { Tool } from "@earendil-works/pi-coding-agent";
    await import("@earendil-works/pi-tui");
    export { x } from "@earendil-works/pi-agent-core";
    // import "@earendil-works/pi-fake";`,
    ),
  ).toEqual([
    `${file}: @earendil-works/pi-coding-agent`,
    `${file}: @earendil-works/pi-tui`,
    `${file}: @earendil-works/pi-agent-core`,
  ]);
});

it("scans every TypeScript source import", async () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  async function scan(dir: string): Promise<string[]> {
    const failures: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) failures.push(...(await scan(path)));
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        failures.push(
          ...violations(relative(repo, path).replaceAll("\\", "/"), await readFile(path, "utf8")),
        );
    }
    return failures;
  }
  expect(await scan(join(repo, "src"))).toEqual([]);
});
