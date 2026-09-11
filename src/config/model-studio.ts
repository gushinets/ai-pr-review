import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CENTRAL_CONFIG } from "./central-config.js";
import {
  assertCreatablePathContained,
  assertRealpathContained,
} from "../sandbox/path-containment.js";

const qwenThinking = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "xhigh",
  xhigh: "xhigh",
  max: "xhigh",
} as const;
export async function writeModelStudioConfig(
  runtimeDir: string,
  workspaceId: string,
): Promise<void> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId))
    throw new Error("INVALID_ALIBABA_WORKSPACE_ID");
  if (!isAbsolute(runtimeDir)) throw new Error("INVALID_RUNTIME_DIRECTORY");
  const agentDir = await assertCreatablePathContained(runtimeDir, join(runtimeDir, "pi-agent"));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await assertRealpathContained(runtimeDir, agentDir);
  const thinkingMaps = [
    qwenThinking,
    { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
    { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max", max: "max" },
    qwenThinking,
  ];
  const models = [...CENTRAL_CONFIG.reviewers, CENTRAL_CONFIG.judge].map((model, index) => ({
    id: model.model.slice("model-studio/".length),
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: model.maxTokens,
    thinkingLevelMap: thinkingMaps[index],
  }));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "model-studio": {
          baseUrl: `https://${workspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1`,
          api: "openai-completions",
          apiKey: "$QWEN_API_KEY",
          authHeader: true,
          models,
        },
      },
    }),
    { flag: "wx", mode: 0o600 },
  );
}
