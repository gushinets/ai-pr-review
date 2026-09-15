export const CENTRAL_CONFIG = Object.freeze({
  checkName: "AI PR Review",
  schemaVersion: 1,
  maxChangedFiles: 250,
  maxChangedLines: 20_000,
  maxLinearBytes: 128 * 1024,
  maxFindings: 20,
  artifactRetentionDays: 90,
  reviewTimeoutMs: 50 * 60 * 1000,
  reviewers: [
    { model: "qwen-token-plan/qwen3.8-flash", level: "medium", maxTokens: 32_768 },
    { model: "qwen-token-plan/deepseek-v4-pro-0813", level: "high", maxTokens: 32_768 },
    { model: "qwen-token-plan/glm-5.2", level: "high", maxTokens: 32_768 },
  ],
  judge: { model: "qwen-token-plan/qwen3.8-max", level: "xhigh", maxTokens: 24_576 },
  summaryMarker: "<!-- ai-pr-review-summary:v1 -->",
  findingMarkerPrefix: "ai-pr-review-finding:v1",
} as const);
