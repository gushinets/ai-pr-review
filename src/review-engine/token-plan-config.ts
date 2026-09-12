import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  assertCreatablePathContained,
  assertRealpathContained,
} from "../sandbox/path-containment.js";

export const TOKEN_PLAN_PROVIDER_ID = "qwen-token-plan" as const;
export const TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" as const;
export const TOKEN_PLAN_API_KEY_ENV = "QWEN_TOKEN_PLAN_API_KEY" as const;

// Resolve runtime exports without importing Pi's incompatible upstream declaration graph.
const native = await import(import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan"));
const individual = await import(
  import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan-individual")
);
interface CatalogModel extends Record<string, unknown> {
  id: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}
function catalog() {
  const provider = native.qwenTokenPlanProvider();
  const models: CatalogModel[] = provider.getModels();
  const source: CatalogModel | undefined = individual
    .qwenTokenPlanIndividualProvider()
    .getModels()
    .find((m: CatalogModel) => m.id === "deepseek-v4-pro-0813");
  const flash = models.find((m) => m.id === "qwen3.8-flash");
  const judge = models.find((m) => m.id === "qwen3.8-max");
  if (
    provider.id !== TOKEN_PLAN_PROVIDER_ID ||
    provider.baseUrl !== TOKEN_PLAN_BASE_URL ||
    ["qwen3.8-flash", "glm-5.2", "qwen3.8-max"].some(
      (id) =>
        !models.some(
          (m) => m.id === id && m.api === "openai-completions" && m.baseUrl === TOKEN_PLAN_BASE_URL,
        ),
    ) ||
    !flash?.reasoning ||
    !flash.thinkingLevelMap?.medium ||
    !judge?.reasoning ||
    !judge.thinkingLevelMap?.xhigh ||
    !source ||
    source.api !== "openai-completions"
  )
    throw new Error("PROVIDER_CONFIG_INVALID");
  return source;
}
export function assertTokenPlanRuntimeContract(): void {
  catalog();
}
export async function writeTokenPlanConfig(runtimeDir: string): Promise<void> {
  const source = catalog();
  if (!isAbsolute(runtimeDir)) throw new Error("INVALID_RUNTIME_DIRECTORY");
  const agentDir = await assertCreatablePathContained(runtimeDir, join(runtimeDir, "pi-agent"));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await assertRealpathContained(runtimeDir, agentDir);
  const model = Object.fromEntries(
    [
      "id",
      "name",
      "api",
      "reasoning",
      "thinkingLevelMap",
      "input",
      "contextWindow",
      "samplingParams",
      "headers",
      "compat",
    ]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [TOKEN_PLAN_PROVIDER_ID]: {
          modelOverrides: {
            "qwen3.8-flash": { maxTokens: 32768 },
            "glm-5.2": { maxTokens: 32768 },
            "qwen3.8-max": { maxTokens: 24576 },
          },
          models: [{ ...model, maxTokens: 32768 }],
        },
      },
    }),
    { flag: "wx", mode: 0o600 },
  );
}
