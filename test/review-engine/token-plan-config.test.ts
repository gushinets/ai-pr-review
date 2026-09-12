import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertTokenPlanRuntimeContract,
  getTokenPlanEffectiveReasoning,
  writeTokenPlanConfig,
  TOKEN_PLAN_PROVIDER_ID,
  TOKEN_PLAN_BASE_URL,
  TOKEN_PLAN_API_KEY_ENV,
} from "../../src/review-engine/token-plan-config.js";

const native = await import(import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan"));
const individual = await import(
  import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan-individual")
);
const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock(import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan"));
  vi.doUnmock(import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan-individual"));
  vi.resetModules();
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "token-plan-test-"));
  temps.push(dir);
  return dir;
}
it("uses native Singapore routing, reasoning support and only the Token Plan credential", async () => {
  expect(TOKEN_PLAN_PROVIDER_ID).toBe("qwen-token-plan");
  expect(TOKEN_PLAN_BASE_URL).toBe(
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  );
  expect(TOKEN_PLAN_API_KEY_ENV).toBe("QWEN_TOKEN_PLAN_API_KEY");
  expect(() => assertTokenPlanRuntimeContract()).not.toThrow();
  const provider = native.qwenTokenPlanProvider();
  expect(provider.id).toBe(TOKEN_PLAN_PROVIDER_ID);
  expect(provider.baseUrl).toBe(TOKEN_PLAN_BASE_URL);
  const seen: string[] = [];
  const resolve = (key?: string) =>
    provider.auth.apiKey.resolve({
      signal: new AbortController().signal,
      ctx: {
        env: (name: string) => {
          seen.push(name);
          return name === "QWEN_TOKEN_PLAN_API_KEY" ? key : "legacy-canary";
        },
      },
    });
  expect(await resolve()).toBeUndefined();
  expect(await resolve("sk-sp-test")).toMatchObject({ auth: { apiKey: "sk-sp-test" } });
  expect(seen).toEqual(["QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"]);
});
it("resolves effective reasoning from the pinned Pi catalogs for every panel model", () => {
  expect(
    [
      ["qwen3.8-flash", "medium", "medium"],
      ["deepseek-v4-pro-0813", "high", "high"],
      ["glm-5.2", "high", "high"],
      ["qwen3.8-max", "xhigh", "xhigh"],
    ].map(([model, requested]) =>
      getTokenPlanEffectiveReasoning(model!, requested as "medium" | "high" | "xhigh"),
    ),
  ).toEqual(["medium", "high", "high", "xhigh"]);
});
it("writes only native token overrides and allowlisted Individual snapshot capabilities", async () => {
  const dir = await runtime();
  await writeTokenPlanConfig(dir);
  const raw = await readFile(join(dir, "pi-agent/models.json"), "utf8");
  const source = individual
    .qwenTokenPlanIndividualProvider()
    .getModels()
    .find((m: { id: string }) => m.id === "deepseek-v4-pro-0813");
  expect(source).toBeDefined();
  const custom = Object.fromEntries(
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
  expect(JSON.parse(raw)).toEqual({
    providers: {
      "qwen-token-plan": {
        modelOverrides: {
          "qwen3.8-flash": { maxTokens: 32768 },
          "glm-5.2": { maxTokens: 32768 },
          "qwen3.8-max": { maxTokens: 24576 },
        },
        models: [{ ...custom, maxTokens: 32768 }],
      },
    },
  });
  expect(raw).not.toMatch(
    /model-studio|eu-central-1|ALIBABA_WORKSPACE_ID|QWEN_API_KEY|BAILIAN_TOKEN_PLAN_API_KEY|generationConfig|extra_body|thinkingMandatory|qwen3\.8-max-0902|"cost"|"video"|"baseUrl"|"apiKey"|sk-sp-/,
  );
});
it.each(["id", "baseUrl", "api", "missing-flash", "missing-glm", "missing-max", "medium", "xhigh"])(
  "fails closed for catalog drift: %s",
  async (change) => {
    const provider = native.qwenTokenPlanProvider();
    const models = structuredClone(provider.getModels());
    const flash = models.find((m: { id: string }) => m.id === "qwen3.8-flash");
    const judge = models.find((m: { id: string }) => m.id === "qwen3.8-max");
    if (change === "api") flash.api = "other";
    if (change === "medium") flash.thinkingLevelMap.medium = null;
    if (change === "xhigh") judge.thinkingLevelMap.xhigh = null;
    const removed = {
      "missing-flash": "qwen3.8-flash",
      "missing-glm": "glm-5.2",
      "missing-max": "qwen3.8-max",
    }[change];
    vi.doMock(import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan"), () => ({
      qwenTokenPlanProvider: () => ({
        ...provider,
        ...(change === "id" || change === "baseUrl" ? { [change]: "wrong" } : {}),
        getModels: () => models.filter((m: { id: string }) => m.id !== removed),
      }),
    }));
    vi.resetModules();
    const runtime = await import("../../src/review-engine/token-plan-config.js");
    expect(() => runtime.assertTokenPlanRuntimeContract()).toThrow("PROVIDER_CONFIG_INVALID");
  },
);
it("requires the exact Individual snapshot", async () => {
  const provider = individual.qwenTokenPlanIndividualProvider();
  vi.doMock(
    import.meta.resolve("@earendil-works/pi-ai/providers/qwen-token-plan-individual"),
    () => ({ qwenTokenPlanIndividualProvider: () => ({ ...provider, getModels: () => [] }) }),
  );
  vi.resetModules();
  const runtime = await import("../../src/review-engine/token-plan-config.js");
  expect(() => runtime.assertTokenPlanRuntimeContract()).toThrow("PROVIDER_CONFIG_INVALID");
});
it("does not follow linked agent directories or overwrite existing config", async () => {
  const dir = await runtime();
  await symlink(await runtime(), join(dir, "pi-agent"), "junction");
  await expect(writeTokenPlanConfig(dir)).rejects.toThrow();
  const clean = await runtime();
  await mkdir(join(clean, "pi-agent"));
  await writeFile(join(clean, "pi-agent/models.json"), "existing");
  await expect(writeTokenPlanConfig(clean)).rejects.toThrow();
  expect(await readFile(join(clean, "pi-agent/models.json"), "utf8")).toBe("existing");
  await expect(writeTokenPlanConfig("relative")).rejects.toThrow("INVALID_RUNTIME_DIRECTORY");
});
