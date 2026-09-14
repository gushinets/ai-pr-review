import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CENTRAL_CONFIG } from "../../src/config/central-config.js";

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
type Job = {
  "runs-on": string;
  "timeout-minutes"?: number;
  permissions: Record<string, string>;
  needs?: string[] | string;
  if?: string;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
};
const file = ".github/workflows/reusable-ai-pr-review.yml";
function workflow() {
  expect(existsSync(file), "central reusable workflow must exist").toBe(true);
  return parse(readFileSync(file, "utf8")) as {
    on: Record<string, { inputs: Record<string, unknown>; secrets: Record<string, unknown> }>;
    permissions: Record<string, string>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
  };
}
function step(job: Job, id: string): Step {
  const found = job.steps.find((item) => item.id === id);
  expect(found, `missing step ${id}`).toBeDefined();
  return found!;
}
const readPermissions = {
  actions: "read",
  contents: "read",
  "pull-requests": "read",
  checks: "read",
  statuses: "read",
};
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
function shell(script: string, env: Record<string, string> = {}, before = "") {
  const directory = mkdtempSync(join(tmpdir(), "ai-workflow-test-"));
  const path = directory.replaceAll("\\", "/");
  try {
    const result = spawnSync(
      bash,
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${before}\n${script}`],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: path,
          GITHUB_OUTPUT: `${path}/output`,
          CAPTURE: `${path}/args`,
          ...env,
        },
      },
    );
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: existsSync(join(directory, "output"))
        ? readFileSync(join(directory, "output"), "utf8")
        : "",
      args: existsSync(join(directory, "args"))
        ? readFileSync(join(directory, "args"), "utf8").split("\0").slice(0, -1)
        : [],
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const captureNpm = 'npm() { printf "%s\\0" "$@" > "$CAPTURE"; return "${CLI_EXIT:-0}"; }';

describe("central reusable workflow security contract", () => {
  it("accepts only the explicit reusable inputs and named secrets", () => {
    const flow = workflow();
    expect(Object.keys(flow.on)).toEqual(["workflow_call"]);
    expect(flow.on.workflow_call!.inputs).toEqual({
      mode: { required: true, type: "string" },
      triggering_run_id: { required: false, type: "string", default: "" },
      pr_number: { required: false, type: "number", default: 0 },
    });
    expect(flow.on.workflow_call!.secrets).toEqual({
      QWEN_TOKEN_PLAN_API_KEY: { required: true },
      LINEAR_CLIENT_ID: { required: true },
      LINEAR_CLIENT_SECRET: { required: true },
    });
    expect(flow.permissions).toEqual({});
    expect(flow.env).toBeUndefined();
    expect(JSON.stringify(flow)).not.toMatch(
      /alibaba_workspace_id|ALIBABA_WORKSPACE_ID|QWEN_API_KEY|BAILIAN_TOKEN_PLAN_API_KEY/,
    );
    for (const job of Object.values(flow.jobs)) {
      for (const item of job.steps.filter((item) => item.id !== "execute"))
        expect(JSON.stringify(item)).not.toContain("QWEN_TOKEN_PLAN_API_KEY");
    }
    expect(JSON.stringify(flow)).not.toMatch(/secrets[^\n]*inherit/);
    expect(Object.keys(flow.jobs)).toEqual(["preflight", "review", "publisher"]);
  });
  it("bootstraps only the called central commit on every fresh runner", () => {
    for (const job of Object.values(workflow().jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-24.04");
      expect(job.env).toBeUndefined();
      expect(job.steps[0]).toMatchObject({
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          repository: "${{ job.workflow_repository }}",
          ref: "${{ job.workflow_sha }}",
          "persist-credentials": false,
        },
      });
      expect(job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"))).toHaveLength(1);
      const verify = job.steps[1]!;
      expect(verify.env).toEqual({ ENGINE_SHA: "${{ job.workflow_sha }}" });
      expect(shell(verify.run!, { ENGINE_SHA: "abc" }, 'git() { printf "abc\\n"; }').status).toBe(
        0,
      );
      expect(
        shell(verify.run!, { ENGINE_SHA: "def" }, 'git() { printf "abc\\n"; }').status,
      ).not.toBe(0);
      expect(job.steps[2]).toMatchObject({
        uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
        with: { "node-version": "22.19.0" },
      });
      expect(job.steps[3]!.run).toBe("npm ci");
      expect(job.steps[4]!.run).toBe("npm run build");
      for (const s of job.steps) {
        if (s.uses) expect(s.uses).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
        if (s.run) expect(s.run).not.toContain("${{");
        expect(s["continue-on-error"]).toBeUndefined();
      }
    }
  });
  it("isolates credentials by job and phase and gates model execution", () => {
    const { preflight, review, publisher } = workflow().jobs;
    expect(preflight!.permissions).toEqual(readPermissions);
    expect(review!.permissions).toEqual(readPermissions);
    expect(publisher!.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "write",
      checks: "write",
    });
    for (const job of [preflight!, publisher!])
      expect(JSON.stringify(job)).not.toMatch(/QWEN|LINEAR|ALIBABA/);
    expect(review!["timeout-minutes"]).toBe(40);
    expect(review!.needs).toBe("preflight");
    expect(review!.if).toBe(
      "needs.preflight.outputs.status == 'READY' || needs.preflight.outputs.status == 'UNABLE_TO_REVIEW'",
    );
    const unable = step(review!, "unable"),
      prepare = step(review!, "prepare"),
      execute = step(review!, "execute");
    expect(unable.if).toBe("needs.preflight.outputs.status == 'UNABLE_TO_REVIEW'");
    expect(prepare.if).toBe("needs.preflight.outputs.status == 'READY'");
    expect(execute.if).toBe("steps.prepare.outputs.action == 'EXECUTE'");
    expect(unable.env!.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(unable.env)).not.toMatch(/QWEN|LINEAR_CLIENT|ALIBABA/);
    expect(prepare.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      LINEAR_CLIENT_ID: "${{ secrets.LINEAR_CLIENT_ID }}",
      LINEAR_CLIENT_SECRET: "${{ secrets.LINEAR_CLIENT_SECRET }}",
    });
    expect(JSON.stringify(prepare.env)).not.toMatch(/QWEN|ALIBABA/);
    expect(execute.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      QWEN_TOKEN_PLAN_API_KEY: "${{ secrets.QWEN_TOKEN_PLAN_API_KEY }}",
    });
    expect(JSON.stringify(execute.env)).not.toMatch(/LINEAR_CLIENT/);
    const bootstrap = step(review!, "search-tools");
    expect(bootstrap.env).toBeUndefined();
    expect(bootstrap.run).toContain(
      "sudo apt-get install -y --no-install-recommends ripgrep fd-find",
    );
    expect(bootstrap.run).toContain("rg --version");
    expect(bootstrap.run).toContain("fdfind --version");
    expect(review!.steps.indexOf(bootstrap)).toBeLessThan(review!.steps.indexOf(unable));
    for (const phase of [unable, prepare, execute])
      expect(phase.env!.ENGINE_SHA).toBe("${{ job.workflow_sha }}");
    expect(step(publisher!, "publish").env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
  });

  it("keeps the GitHub review timeout above the engine deadline", () => {
    const githubReviewTimeoutMinutes = workflow().jobs.review!["timeout-minutes"]!;

    expect(CENTRAL_CONFIG.reviewTimeoutMs).toBe(35 * 60 * 1000);
    expect(githubReviewTimeoutMinutes).toBe(40);
    expect(githubReviewTimeoutMinutes * 60_000).toBeGreaterThan(CENTRAL_CONFIG.reviewTimeoutMs);
    expect(
      githubReviewTimeoutMinutes * 60_000 - CENTRAL_CONFIG.reviewTimeoutMs,
    ).toBeGreaterThanOrEqual(5 * 60_000);
  });
  it("passes sanitized preflight outputs only and rejects mixed input modes", () => {
    const job = workflow().jobs.preflight!;
    expect(job.outputs).toEqual(
      Object.fromEntries(
        [
          "status",
          "repository",
          "pr_number",
          "base_branch",
          "base_sha",
          "head_sha",
          "linear_issue",
          "unable_reason",
        ].map((key) => [key, `\${{ steps.preflight.outputs.${key} }}`]),
      ),
    );
    const run = step(job, "preflight").run!;
    const automatic = shell(
      run,
      {
        MODE: "automatic",
        TRIGGERING_RUN_ID: "42",
        PR_NUMBER: "0",
        REPOSITORY: "owner/repo",
        ENGINE_SHA: "a",
      },
      captureNpm,
    );
    expect(automatic.status).toBe(0);
    expect(automatic.args).toEqual([
      "run",
      "cli:preflight",
      "--",
      "--mode",
      "automatic",
      "--repository",
      "owner/repo",
      "--engine-sha",
      "a",
      "--triggering-run-id",
      "42",
    ]);
    const manual = shell(
      run,
      {
        MODE: "manual",
        TRIGGERING_RUN_ID: "",
        PR_NUMBER: "7",
        REPOSITORY: "owner/repo",
        ENGINE_SHA: "a",
      },
      captureNpm,
    );
    expect(manual.status).toBe(0);
    expect(manual.args.slice(-2)).toEqual(["--pr-number", "7"]);
    for (const env of [
      { MODE: "bad", PR_NUMBER: "0", TRIGGERING_RUN_ID: "42" },
      { MODE: "automatic", PR_NUMBER: "7", TRIGGERING_RUN_ID: "42" },
      { MODE: "manual", PR_NUMBER: "7", TRIGGERING_RUN_ID: "42" },
    ]) {
      const result = shell(run, env, captureNpm);
      expect(result.status).not.toBe(0);
      expect(result.args).toEqual([]);
    }
  });
  it("preserves quoted metadata and treats only documented stale exit as success", () => {
    const review = workflow().jobs.review!;
    for (const id of ["unable", "prepare", "execute"]) {
      const run = step(review, id).run!;
      for (const [code, expected] of [
        [0, 0],
        [20, 0],
        [21, 21],
        [1, 1],
        [70, 70],
        [99, 99],
      ]) {
        const result = shell(
          run,
          {
            CLI_EXIT: String(code),
            REPOSITORY: "owner/$(touch injected)",
            PR_NUMBER: "7",
            BASE_SHA: "base",
            HEAD_SHA: "head",
            ENGINE_SHA: "engine",
            LINEAR_ISSUE: "ENG-7",
            UNABLE_REASON: "CONFIG_INVALID",
          },
          captureNpm,
        );
        expect(result.status, result.stderr).toBe(expected);
        expect(result.args.slice(0, 8)).toEqual([
          "run",
          "cli:review",
          "--",
          id === "unable" ? "emit-preflight-unable" : id,
          "--repository",
          "owner/$(touch injected)",
          "--pr-number",
          "7",
        ]);
        expect(result.args).toContain("--state-out");
        expect(result.args).not.toContain("--base-branch");
      }
    }
    const absent = shell(
      step(review, "unable").run!,
      { LINEAR_ISSUE: "", UNABLE_REASON: "PR_METADATA_INVALID" },
      captureNpm,
    );
    expect(absent.status).toBe(0);
    expect(absent.args).not.toContain("--linear-issue");
  });
  it("classifies only the exact nonempty canonical file and cleans only task data", () => {
    const review = workflow().jobs.review!;
    const classify = step(review, "classify");
    expect(review.outputs).toEqual({ state_ready: "${{ steps.classify.outputs.state_ready }}" });
    for (const [before, expected] of [
      ["", "false"],
      [
        'mkdir -p "$RUNNER_TEMP/ai-pr-review/out"; touch "$RUNNER_TEMP/ai-pr-review/out/ai-review-state-v1.json"',
        "false",
      ],
      [
        'mkdir -p "$RUNNER_TEMP/ai-pr-review/private"; echo private > "$RUNNER_TEMP/ai-pr-review/private/state.json"',
        "false",
      ],
      [
        'mkdir -p "$RUNNER_TEMP/ai-pr-review/out"; echo canonical > "$RUNNER_TEMP/ai-pr-review/out/ai-review-state-v1.json"',
        "true",
      ],
    ]) {
      const result = shell(classify.run!, {}, before);
      expect(result.status).toBe(0);
      expect(result.output).toBe(`state_ready=${expected}\n`);
    }
    const cleanup = step(review, "cleanup");
    expect(cleanup.if).toBe("always()");
    const result = shell(
      `${cleanup.run}\ntest -f "$RUNNER_TEMP/unrelated/keep"\ntest ! -e "$RUNNER_TEMP/ai-pr-review/private"`,
      {},
      'mkdir -p "$RUNNER_TEMP/unrelated" "$RUNNER_TEMP/ai-pr-review/private/runtime"; touch "$RUNNER_TEMP/unrelated/keep"',
    );
    expect(result.status).toBe(0);
  });
  it("persists only canonical state before a separately bootstrapped publisher", () => {
    const { review, publisher } = workflow().jobs;
    const upload = step(review!, "upload");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.if).toBe("steps.classify.outputs.state_ready == 'true'");
    expect(upload.with).toEqual({
      name: "ai-review-state-v1-pr-${{ needs.preflight.outputs.pr_number }}",
      path: "${{ runner.temp }}/ai-pr-review/out/ai-review-state-v1.json",
      "if-no-files-found": "error",
      "retention-days": 90,
    });
    expect(review!.steps.indexOf(step(review!, "classify"))).toBeGreaterThan(
      review!.steps.indexOf(step(review!, "execute")),
    );
    expect(review!.steps.indexOf(upload)).toBeGreaterThan(
      review!.steps.indexOf(step(review!, "classify")),
    );
    expect(review!.steps.indexOf(step(review!, "cleanup"))).toBeGreaterThan(
      review!.steps.indexOf(upload),
    );
    expect(publisher!.needs).toEqual(["preflight", "review"]);
    // Upload is mandatory with state_ready=true and cannot continue on failure, so success proves persistence.
    expect(publisher!.if).toBe(
      "needs.review.result == 'success' && needs.review.outputs.state_ready == 'true'",
    );
    expect(publisher!.steps[5]).toMatchObject({
      uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      with: {
        name: "ai-review-state-v1-pr-${{ needs.preflight.outputs.pr_number }}",
        path: "${{ runner.temp }}/ai-pr-review/out",
      },
    });
    expect(Object.keys(publisher!.steps[5]!.with!)).toEqual(["name", "path"]);
    const published = shell(step(publisher!, "publish").run!, {}, captureNpm);
    expect(published.status).toBe(0);
    expect(published.args.slice(0, 4)).toEqual(["run", "cli:publish", "--", "--state-file"]);
    expect(published.args[4]).toMatch(/\/ai-pr-review\/out\/ai-review-state-v1.json$/);
  });
});
