import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeTokenPlanConfig } from "../../src/review-engine/token-plan-config.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "token-plan-protocol-"));
  temps.push(dir);
  await writeTokenPlanConfig(dir);
  const { ModelRuntime } = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const runtime = await ModelRuntime.create({
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
    modelsPath: join(dir, "pi-agent/models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  expect(runtime.getError()).toBeUndefined();
  return runtime;
}

async function requestBody(modelId: string, reasoningEffort: "medium" | "high" | "xhigh") {
  const modelRuntime = await runtime();
  const model = modelRuntime.getModel("qwen-token-plan", modelId);
  expect(model).toBeDefined();
  const requests: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeTypeOf("string");
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      `data: ${JSON.stringify({
        id: "protocol-canary",
        model: modelId,
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  await modelRuntime.complete(
    model!,
    { messages: [{ role: "user", content: "protocol canary", timestamp: 0 }] },
    { apiKey: "sk-sp-test", fetch, reasoningEffort, maxTokens: 32 },
  );
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

it.each([
  ["qwen3.8-flash", "medium"],
  ["qwen3.8-max", "xhigh"],
  ["deepseek-v4-pro-0813", "high"],
  ["glm-5.2", "high"],
] as const)(
  "verifies pinned Token Plan outbound thinking protocol for %s@%s",
  async (model, level) => {
    const body = await requestBody(model, level);
    expect(body).toMatchObject({
      model,
      enable_thinking: true,
      reasoning_effort: level,
    });
    expect(body).not.toHaveProperty("generationConfig");
    expect(body).not.toHaveProperty("extra_body");
  },
);
