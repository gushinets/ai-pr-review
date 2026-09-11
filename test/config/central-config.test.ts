import { describe, expect, it } from "vitest";
import { CENTRAL_CONFIG } from "../../src/config/central-config.js";

describe("CENTRAL_CONFIG", () => {
  it("contains the exact frozen V1 policy", () => {
    expect(CENTRAL_CONFIG).toEqual({
      checkName: "AI PR Review",
      schemaVersion: 1,
      maxChangedFiles: 250,
      maxChangedLines: 20_000,
      maxLinearBytes: 128 * 1024,
      maxFindings: 20,
      artifactRetentionDays: 90,
      reviewTimeoutMs: 20 * 60 * 1000,
      reviewers: [
        { model: "model-studio/qwen3.8-flash", level: "medium", maxTokens: 32_768 },
        { model: "model-studio/deepseek-v4-pro-0813", level: "high", maxTokens: 32_768 },
        { model: "model-studio/glm-5.2", level: "high", maxTokens: 32_768 },
      ],
      judge: { model: "model-studio/qwen3.8-max-0902", level: "high", maxTokens: 24_576 },
      summaryMarker: "<!-- ai-pr-review-summary:v1 -->",
      findingMarkerPrefix: "ai-pr-review-finding:v1",
    });
    expect(Object.isFrozen(CENTRAL_CONFIG)).toBe(true);
  });
});
