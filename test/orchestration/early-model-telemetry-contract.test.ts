import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("seeds all four not-started model slots before provider validation", () => {
  const source = readFileSync("src/orchestration/review-pipeline.ts", "utf8");
  const start = source.indexOf("function initialState(");
  const end = source.indexOf("async function finish(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const initialState = source.slice(start, end);
  for (const role of ["reviewer_1", "reviewer_2", "reviewer_3", "judge"])
    expect(initialState).toContain(`role: "${role}"`);
  for (const model of [
    "qwen-token-plan/qwen3.8-flash",
    "qwen-token-plan/deepseek-v4-pro-0813",
    "qwen-token-plan/glm-5.2",
    "qwen-token-plan/qwen3.8-max",
  ])
    expect(initialState).toContain(model);
  expect(initialState).toContain('status: "not_started"');
  expect(initialState).toContain("duration_ms: null");

  // The slots must already exist before assertTokenPlanRuntimeContract can fail.
  const providerGate = source.indexOf("assertTokenPlanRuntimeContract();");
  const modelSeed = source.indexOf('status: "not_started"', start);
  expect(modelSeed).toBeGreaterThanOrEqual(start);
  expect(modelSeed).toBeLessThan(providerGate);
});
