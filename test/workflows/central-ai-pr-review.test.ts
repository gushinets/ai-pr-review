import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("dispatches centrally and keeps model, App and publication credentials in separate steps", async () => {
  const raw = await readFile(
    new URL("../../.github/workflows/central-ai-pr-review.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(raw);
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({});
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.jobs.review.permissions["pull-requests"]).toBeUndefined();
  const steps = workflow.jobs.review.steps;
  const model = steps.find((step: { id?: string }) => step.id === "execute");
  expect(model.env.QWEN_TOKEN_PLAN_API_KEY).toBeDefined();
  expect(model.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
  expect(model.env.LINEAR_CLIENT_SECRET).toBeUndefined();
  expect(model.env.STATE_READ_TOKEN).toBeUndefined();
  const graph = steps.find((step: { id?: string }) => step.id === "graph");
  expect(Object.keys(graph.env)).not.toContain("TARGET_READ_TOKEN");
  expect(Object.keys(graph.env)).not.toContain("QWEN_TOKEN_PLAN_API_KEY");
  expect(JSON.stringify(workflow.jobs.publisher)).not.toContain("QWEN_TOKEN_PLAN_API_KEY");
  expect(JSON.stringify(workflow.jobs.publisher)).not.toContain("LINEAR_CLIENT_SECRET");
  expect(workflow.jobs.completion.if).toContain("trigger.kind == 'app'");
  expect(workflow.jobs.completion.if).toContain("trigger.kind == 'app'");
  expect(raw).not.toContain("secrets: inherit");
  expect(raw).not.toMatch(/run:.*\$\{\{.*(?:request|repository|headSha)/);
});
