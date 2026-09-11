import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface CapturedRejudgeTool {
  name: "rejudge";
  parameters: Record<string, unknown>;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function loadRejudgeTool(): Promise<CapturedRejudgeTool> {
  const incompatible = () => new Error("REJUDGE_EXTENSION_INCOMPATIBLE");
  const path = createRequire(import.meta.url).resolve("rejudge/dist/extension.js");
  const namespace: unknown = await import(pathToFileURL(path).href);
  if (!isRecord(namespace) || !("default" in namespace) || typeof namespace.default !== "function")
    throw incompatible();
  const registered: unknown[] = [];
  await namespace.default(
    Object.freeze({
      registerTool: (tool: unknown) => {
        registered.push(tool);
      },
    }),
  );
  const tool = registered[0];
  if (
    registered.length !== 1 ||
    !isRecord(tool) ||
    tool.name !== "rejudge" ||
    typeof tool.execute !== "function" ||
    !isRecord(tool.parameters)
  )
    throw incompatible();
  return tool as unknown as CapturedRejudgeTool;
}
