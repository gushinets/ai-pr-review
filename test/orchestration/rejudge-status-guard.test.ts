import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("does not mark Rejudge failed before an engine exists", () => {
  const source = readFileSync("src/orchestration/review-pipeline.ts", "utf8");
  const execute = source.indexOf("export async function executeReview(");
  const caught = source.indexOf("} catch (error) {", execute);
  const telemetry = source.indexOf("applyModelTelemetry(state", caught);

  expect(execute).toBeGreaterThanOrEqual(0);
  expect(caught).toBeGreaterThan(execute);
  expect(telemetry).toBeGreaterThan(caught);

  const failurePath = source.slice(caught, telemetry);
  expect(failurePath).toContain("if (engine !== undefined)");
  expect(failurePath).not.toContain("if (state.telemetry.models.length)");
});
