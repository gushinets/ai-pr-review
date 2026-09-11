import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CENTRAL_CONFIG } from "../../src/config/central-config.js";
import { writeModelStudioConfig } from "../../src/config/model-studio.js";
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "models-test-"));
  temps.push(dir);
  return dir;
}
it("writes only the four approved Frankfurt models and never serializes a provider secret", async () => {
  const dir = await runtime();
  await writeModelStudioConfig(dir, "Workspace-123");
  const raw = await readFile(join(dir, "pi-agent/models.json"), "utf8");
  const config = JSON.parse(raw);
  const qwen = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "xhigh",
    xhigh: "xhigh",
    max: "xhigh",
  };
  expect(config).toEqual({
    providers: {
      "model-studio": {
        baseUrl: "https://Workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        apiKey: "$QWEN_API_KEY",
        authHeader: true,
        models: [
          {
            id: "qwen3.8-flash",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 32768,
            thinkingLevelMap: qwen,
          },
          {
            id: "deepseek-v4-pro-0813",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 32768,
            thinkingLevelMap: {
              minimal: "low",
              low: "low",
              medium: "high",
              high: "high",
              xhigh: "max",
              max: "max",
            },
          },
          {
            id: "glm-5.2",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 32768,
            thinkingLevelMap: {
              minimal: "high",
              low: "high",
              medium: "high",
              high: "high",
              xhigh: "max",
              max: "max",
            },
          },
          {
            id: "qwen3.8-max-0902",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 24576,
            thinkingLevelMap: qwen,
          },
        ],
      },
    },
  });
  expect(
    config.providers["model-studio"].models.map((m: { maxTokens: number }) => m.maxTokens),
  ).toEqual([...CENTRAL_CONFIG.reviewers, CENTRAL_CONFIG.judge].map((m) => m.maxTokens));
  expect(raw).not.toContain("thinking_budget");
  expect(raw).not.toContain('"cost"');
});
it.each(["", "-bad", "bad-", "a.b", "a/b", "https://evil", "a\n", "a".repeat(64), "a_1"])(
  "rejects workspace routing %j",
  async (value) => {
    const dir = await runtime();
    await expect(writeModelStudioConfig(dir, value)).rejects.toThrow(
      "INVALID_ALIBABA_WORKSPACE_ID",
    );
  },
);
it("does not follow a linked agent directory or replace an existing configuration", async () => {
  const dir = await runtime();
  const outside = await runtime();
  await symlink(outside, join(dir, "pi-agent"), "junction");
  await expect(writeModelStudioConfig(dir, "a")).rejects.toThrow();
  const clean = await runtime();
  await mkdir(join(clean, "pi-agent"));
  await writeFile(join(clean, "pi-agent/models.json"), "existing");
  await expect(writeModelStudioConfig(clean, "a")).rejects.toThrow();
  expect(await readFile(join(clean, "pi-agent/models.json"), "utf8")).toBe("existing");
});

it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
  "rejects workspace suffix terminator %j",
  async (suffix) => {
    const directory = await mkdtemp(join(tmpdir(), "model-workspace-"));
    try {
      await expect(writeModelStudioConfig(directory, "workspace" + suffix)).rejects.toThrow(
        "INVALID_ALIBABA_WORKSPACE_ID",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
