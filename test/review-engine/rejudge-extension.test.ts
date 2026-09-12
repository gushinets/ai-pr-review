import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const extensionUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("rejudge/dist/extension.js"),
).href;
afterEach(() => {
  vi.doUnmock(extensionUrl);
  vi.resetModules();
});

it("loads the shipped pinned Rejudge tool without executing it", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const installed = JSON.parse(
    await readFile(createRequire(import.meta.url).resolve("rejudge/package.json"), "utf8"),
  );
  expect(installed.version).toBe("0.4.1");
  expect(lock.packages["node_modules/rejudge"].version).toBe("0.4.1");
  expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version).toBe("0.85.1");
  expect(lock.packages[""].dependencies.rejudge).toBe("0.4.1");
  expect(lock.packages[""].dependencies["@earendil-works/pi-coding-agent"]).toBe("0.85.1");
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
    expect(lock.packages[""].dependencies[name]).toBe("0.85.1");
    expect(lock.packages[`node_modules/${name}`].version).toBe("0.85.1");
  }
  const { loadRejudgeTool } = await import("../../src/review-engine/rejudge-extension.js");
  const tool = await loadRejudgeTool();
  expect(tool.name).toBe("rejudge");
  expect(tool.execute).toBeTypeOf("function");
  expect(tool.parameters).toMatchObject({
    properties: {
      question: { type: "string" },
      outputInstructions: { type: "string" },
      resumeRunId: { type: "string" },
    },
  });
  // 0.4.1 allows history-only queries in its schema; execution still requires a question.
  expect(
    await tool.execute("probe", {}, undefined, undefined, { cwd: process.cwd() }),
  ).toMatchObject({
    content: [
      { type: "text", text: "rejudge failed: question is required unless history is true" },
    ],
  });
});

it.each([
  ["missing default", {}],
  ["zero tools", { default: () => {} }],
  [
    "wrong tool",
    {
      default: (api: { registerTool: (tool: unknown) => void }) =>
        api.registerTool({ name: "other", execute: async () => {}, parameters: {} }),
    },
  ],
  [
    "multiple tools",
    {
      default: (api: { registerTool: (tool: unknown) => void }) => {
        for (let i = 0; i < 2; i++)
          api.registerTool({ name: "rejudge", execute: async () => {}, parameters: {} });
      },
    },
  ],
  [
    "missing execute",
    {
      default: (api: { registerTool: (tool: unknown) => void }) =>
        api.registerTool({ name: "rejudge", parameters: {} }),
    },
  ],
])("rejects incompatible extension registration: %s", async (_name, namespace) => {
  vi.doMock(extensionUrl, () => namespace);
  const { loadRejudgeTool } = await import("../../src/review-engine/rejudge-extension.js");
  await expect(loadRejudgeTool()).rejects.toThrow("REJUDGE_EXTENSION_INCOMPATIBLE");
});
