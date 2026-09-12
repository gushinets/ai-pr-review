import { realpath } from "node:fs/promises";
import { dirname } from "node:path";

type ToolName = "read" | "grep" | "find" | "ls";
interface PiFilesystemTool {
  execute: (...args: unknown[]) => Promise<unknown>;
}

export async function loadPiFilesystemTools(
  cwd: string,
): Promise<Record<ToolName, PiFilesystemTool>> {
  // Resolve the public runtime without importing upstream declarations, which do not
  // typecheck under strict NodeNext (JSON attributes and an undeclared MCP dependency).
  const url = import.meta.resolve("@earendil-works/pi-coding-agent");
  const namespace: unknown = await import(url);
  if (typeof namespace !== "object" || namespace === null)
    throw new Error("PI_RUNTIME_INCOMPATIBLE");
  const exports = namespace as Record<string, unknown>;
  function capture(name: ToolName, factory: string): PiFilesystemTool {
    const create = exports[factory];
    if (typeof create !== "function") throw new Error(`PI_RUNTIME_INCOMPATIBLE: ${factory}`);
    const tool: unknown = create(cwd);
    if (
      typeof tool !== "object" ||
      tool === null ||
      !("name" in tool) ||
      tool.name !== name ||
      !("execute" in tool) ||
      typeof tool.execute !== "function"
    )
      throw new Error(`PI_RUNTIME_INCOMPATIBLE: ${name}`);
    return tool as PiFilesystemTool;
  }
  return {
    read: capture("read", "createReadToolDefinition"),
    grep: capture("grep", "createGrepToolDefinition"),
    find: capture("find", "createFindToolDefinition"),
    ls: capture("ls", "createLsToolDefinition"),
  };
}

interface PiModelRuntime {
  getError: () => unknown;
  getModel: (
    provider: string,
    id: string,
  ) =>
    | {
        provider?: string;
        baseUrl?: string;
        reasoning?: boolean;
        thinkingLevelMap?: Record<string, string | null>;
        maxTokens?: number;
      }
    | undefined;
}

export async function loadPiModelRuntime(modelsPath: string): Promise<PiModelRuntime> {
  const url = import.meta.resolve("@earendil-works/pi-coding-agent");
  const namespace: unknown = await import(url);
  if (typeof namespace !== "object" || namespace === null || !("ModelRuntime" in namespace))
    throw new Error("PI_RUNTIME_INCOMPATIBLE");
  const ModelRuntime = namespace.ModelRuntime;
  if (
    (typeof ModelRuntime !== "object" && typeof ModelRuntime !== "function") ||
    ModelRuntime === null ||
    !("create" in ModelRuntime)
  )
    throw new Error("PI_RUNTIME_INCOMPATIBLE");
  const create = ModelRuntime.create;
  if (typeof create !== "function") throw new Error("PI_RUNTIME_INCOMPATIBLE");
  const runtime: unknown = await create({
    credentials: {
      read: () => {
        throw new Error("UNEXPECTED_AUTH_READ");
      },
      list: () => {
        throw new Error("UNEXPECTED_AUTH_LIST");
      },
      modify: () => {
        throw new Error("UNEXPECTED_AUTH_WRITE");
      },
      delete: () => {
        throw new Error("UNEXPECTED_AUTH_DELETE");
      },
    },
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !("getError" in runtime) ||
    typeof runtime.getError !== "function" ||
    !("getModel" in runtime) ||
    typeof runtime.getModel !== "function"
  )
    throw new Error("PI_RUNTIME_INCOMPATIBLE");
  return runtime as PiModelRuntime;
}
export async function assertPiConfinementContract(reviewRoot: string): Promise<void> {
  const failure = () => new Error("PI_CONFINEMENT_CONTRACT_FAILED");
  const configured = process.env.AI_PR_REVIEW_ROOT;
  const root = await realpath(reviewRoot);
  if (!configured || (await realpath(configured)) !== root) throw failure();
  const path = dirname(root);
  if (path === root) throw failure();
  const tools = await loadPiFilesystemTools(root);
  for (const name of ["read", "grep", "find", "ls"] as const) {
    try {
      await tools[name].execute("confinement", { path, pattern: "*" }, undefined, undefined, {
        cwd: root,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ACCESS_DENIED_OUTSIDE_REVIEW_ROOT:"))
        continue;
      throw failure();
    }
    throw failure();
  }
}
