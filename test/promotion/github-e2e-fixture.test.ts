import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRepoConfig } from "../../src/config/repo-config.js";

const ENGINE_SHA = "660525298b8785158fc8339add65f0e5cd87e749";
const _PROMOTION_RUN = "34761353229";
const root = "fixtures/github-e2e";

function read(path: string): string {
  const fullPath = `${root}/${path}`;
  expect(existsSync(fullPath), `${fullPath} must exist`).toBe(true);
  return readFileSync(fullPath, "utf8");
}

function yaml(path: string): Record<string, any> {
  return parse(read(path)) as Record<string, any>;
}

describe("GitHub E2E fixture contract", () => {
  it("pins the caller to the frozen engine and approved inputs/secrets", () => {
    const source = read("caller.yml");
    const flow = yaml("caller.yml");
    expect(source.match(new RegExp(ENGINE_SHA, "g"))).toHaveLength(1);
    expect(source).not.toContain("@main");
    expect(source).not.toMatch(/uses:\s+[^\n]+@(?![0-9a-f]{40}\b)[^\s#]+/);
    expect(flow.on).toEqual({
      workflow_run: { workflows: ["Fixture CI"], types: ["completed"] },
      workflow_dispatch: {
        inputs: {
          pr_number: {
            description: expect.any(String),
            required: true,
            type: "number",
          },
        },
      },
    });
    expect(Object.keys(flow.jobs)).toEqual(["ai-pr-review"]);
    const job = flow.jobs["ai-pr-review"];
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(job.uses).toBe(
      `gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml@${ENGINE_SHA}`,
    );
    expect(flow.permissions).toEqual({
      actions: "read",
      contents: "read",
      statuses: "read",
      "pull-requests": "write",
      checks: "write",
    });
    expect(Object.keys(job.with).sort()).toEqual(["mode", "pr_number", "triggering_run_id"]);
    expect(job.permissions).toBeUndefined();
    expect(Object.keys(job.secrets).sort()).toEqual([
      "LINEAR_CLIENT_ID",
      "LINEAR_CLIENT_SECRET",
      "QWEN_TOKEN_PLAN_API_KEY",
    ]);
    expect(source).not.toMatch(
      /secrets:\s*inherit|engine_sha|alibaba_workspace_id|ALIBABA_WORKSPACE_ID|QWEN_API_KEY|BAILIAN_TOKEN_PLAN_API_KEY|provider|model|region|workspace/i,
    );
  });

  it("keeps primary CI credential-free and read-only", () => {
    const flow = yaml("primary-ci.yml");
    expect(flow.name).toBe("Fixture CI");
    expect(flow.on).toEqual({ pull_request: null });
    expect(flow.permissions).toEqual({ contents: "read" });
    const source = read("primary-ci.yml");
    expect(source).not.toMatch(
      /QWEN|LINEAR|ALIBABA|TOKEN|SECRET|pull-requests:\s*write|checks:\s*write|contents:\s*write/i,
    );
  });

  it("uses the strict production RepoConfigV1 shape", () => {
    expect(parseRepoConfig(read("ai-review.yml"))).toEqual({
      version: 1,
      primary_ci_workflow: "Fixture CI",
      policy: { always: ["AGENTS.md"], scoped: [] },
    });
  });

  it("keeps exact base, bad, and good source fixtures", () => {
    const base = "export {};\n";
    const bad = "export function subtract(a: number, b: number): number {\n  return a + b;\n}\n";
    const good = "export function subtract(a: number, b: number): number {\n  return a - b;\n}\n";
    expect(read("base/calculator.ts")).toBe(base);
    expect(read("bad/calculator.ts")).toBe(bad);
    expect(read("good/calculator.ts")).toBe(good);
    expect(bad.replace("a + b", "a - b")).toBe(good);
    expect(good).not.toBe(base);
  });

  it("documents the frozen promotion and operator lifecycle without secrets", () => {
    const source = read("README.md");
    expect(source).toContain(`ENGINE_CANDIDATE_SHA: ${ENGINE_SHA}`);
    expect(source).toContain(`34761353229`);
    expect(source).toContain("https://github.com/gushinets/ai-pr-review/actions/runs/34761353229");
    expect(source).toContain("E2E_LINEAR_ISSUE=ANY-N");
    expect(source).toContain("base -> bad -> good");
    expect(source).not.toMatch(/sk-sp-|QWEN_TOKEN_PLAN_API_KEY\s*[:=]\s*\S+/);
    expect(source).not.toContain("ANY-483");
    expect(source).not.toContain("paveldik/issue/");
  });
});
