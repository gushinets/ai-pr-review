import { expect, it } from "vitest";
import { parseRejudgeResult, parseWorkerRequest } from "../../src/review-engine/rejudge-worker.js";
const id = "2026-09-11T01-02-03-004Z-abc123";
const metadata = `Run ID: ${id}. Follow up with resumeRunId: "${id}".`;
const result = (text: string) => ({ content: [{ type: "text", text }] });
it.each([
  ["403 insufficient_quota", "PROVIDER_QUOTA_EXHAUSTED"],
  ["403 Forbidden insufficient_quota", "PROVIDER_QUOTA_EXHAUSTED"],
  ["403 credits exhausted", "PROVIDER_QUOTA_EXHAUSTED"],
  ["403 RESOURCE_EXHAUSTED", "PROVIDER_QUOTA_EXHAUSTED"],
  ["403", "PROVIDER_AUTH_FAILED"],
  ["403 invalid_api_key insufficient_quota", "PROVIDER_AUTH_FAILED"],
  ["403 authentication_error credits exhausted", "PROVIDER_AUTH_FAILED"],
])("prioritizes explicit provider codes over HTTP status: %s", (detail, reason) => {
  const diagnostic = vi.fn();
  expect(
    parseRejudgeResult(
      result(
        "rejudge failed: panel (qwen-token-plan/glm-5.2) failed: did not complete cleanly (stopReason: error): " +
          detail,
      ),
      "fresh",
      undefined,
      diagnostic,
    ),
  ).toEqual({
    schema_version: 1,
    ok: false,
    stage: "panel",
    model: "qwen-token-plan/glm-5.2",
    message: "Rejudge execution failed",
    provider_reason: reason,
  });
  expect(diagnostic.mock.calls).toEqual([[reason]]);
});
it.each([
  ["401 Unauthorized", "PROVIDER_AUTH_FAILED"],
  ["403 Forbidden", "PROVIDER_AUTH_FAILED"],
  ["invalid_api_key", "PROVIDER_AUTH_FAILED"],
  ["429 Too Many Requests", "PROVIDER_RATE_LIMITED"],
  ["429 insufficient_quota", "PROVIDER_QUOTA_EXHAUSTED"],
  ["credits exhausted", "PROVIDER_QUOTA_EXHAUSTED"],
  ["RESOURCE_EXHAUSTED", "PROVIDER_QUOTA_EXHAUSTED"],
  ["503 Service Unavailable", "PROVIDER_UNAVAILABLE"],
  ["fetch failed", "PROVIDER_UNAVAILABLE"],
  ["request timed out", "PROVIDER_UNAVAILABLE"],
  ["unclassified provider failure", "PROVIDER_UNAVAILABLE"],
])("classifies shipped model-error evidence %s without carrying raw bodies", (detail, reason) => {
  const diagnostic = vi.fn();
  const response = parseRejudgeResult(
    result(
      "rejudge failed: panel (qwen-token-plan/glm-5.2) failed: did not complete cleanly (stopReason: error): " +
        detail +
        " private-body-canary",
    ),
    "fresh",
    undefined,
    diagnostic,
  );
  expect(response).toMatchObject({ ok: false, stage: "panel", provider_reason: reason });
  expect(JSON.stringify([response, diagnostic.mock.calls])).not.toContain("private-body-canary");
});
it.each([
  "rejudge failed: panel (qwen-token-plan/glm-5.2) failed: 401 local setup",
  "rejudge failed: resume (2026-09-11T01-02-03-004Z-abc123) failed: 429 file error",
  "rejudge failed: panel (other/model) failed: did not complete cleanly (stopReason: error): 401",
  "rejudge failed: judge (qwen-token-plan/qwen3.8-max) aborted",
])("does not guess provider origin: %s", (text) => {
  expect(parseRejudgeResult(result(text), "fresh")).not.toHaveProperty("provider_reason");
});
it("strips exactly the final shipped run metadata line while preserving answer whitespace", () => {
  expect(parseRejudgeResult(result("answer  \n\n" + metadata), "fresh")).toEqual({
    schema_version: 1,
    ok: true,
    answer: "answer  \n",
    run_id: id,
  });
  expect(
    parseRejudgeResult(
      result(`answer\n\nRun ID: ${id} (resumed). Follow up again with resumeRunId: "${id}".`),
      "resume",
      id,
    ),
  ).toMatchObject({ ok: true, run_id: id });
});
it.each([
  "answer",
  `answer\n${metadata}\n`,
  `${metadata}\n${metadata}`,
  `answer\n${metadata.replace('abc123"', 'different"')}`,
  `answer\n${metadata.replaceAll(id, "../../escape")}`,
])("rejects ambiguous/missing metadata %s", (text) => {
  expect(parseRejudgeResult(result(text), "fresh")).toMatchObject({
    ok: false,
    stage: "setup",
    model: null,
  });
});
it.each(["panel", "judge", "resume"] as const)(
  "parses exact %s failures without leaking diagnostics into protocol",
  (stage) => {
    expect(
      parseRejudgeResult(
        result(`rejudge failed: ${stage} (qwen-token-plan/glm-5.2) failed: Bearer raw-secret`),
        "fresh",
      ),
    ).toEqual({
      schema_version: 1,
      ok: false,
      stage,
      model: "qwen-token-plan/glm-5.2",
      message: "Rejudge execution failed",
    });
    expect(
      parseRejudgeResult(
        result(`rejudge failed: ${stage} (qwen-token-plan/glm-5.2) aborted`),
        "fresh",
      ),
    ).toMatchObject({ ok: false, stage });
  },
);
it("fails closed on unknown failure text and malformed protocol requests", () => {
  expect(
    parseRejudgeResult(result("rejudge failed: unexpected provider payload"), "fresh"),
  ).toMatchObject({ ok: false, stage: "setup", model: null });
  for (const value of [
    {},
    {
      schema_version: 1,
      mode: "fresh",
      review_root: "/root",
      runtime_dir: "/runtime",
      prompt: "p",
      output_instructions: "o",
      resume_run_id: id,
    },
    {
      schema_version: 1,
      mode: "resume",
      review_root: "/root",
      runtime_dir: "/runtime",
      prompt: "p",
      output_instructions: "o",
      resume_run_id: "../bad",
    },
  ])
    expect(() => parseWorkerRequest(value)).toThrow();
});

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, vi } from "vitest";
import { createRejudgeEngine } from "../../src/review-engine/rejudge-engine.js";
import { writeTokenPlanConfig } from "../../src/review-engine/token-plan-config.js";
import { CENTRAL_CONFIG } from "../../src/config/central-config.js";
import { installGitDiffShim } from "../../src/sandbox/git-diff-shim.js";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const temps: string[] = [];
afterEach(async () => {
  vi.mocked(nodeSpawn).mockImplementation(actualSpawn);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function layout() {
  const dir = await mkdtemp(join(tmpdir(), "rejudge-worker-"));
  temps.push(dir);
  const reviewRoot = join(dir, "review-root"),
    runtimeDir = join(dir, "runtime");
  await mkdir(join(reviewRoot, ".rejudge"), { recursive: true });
  await mkdir(join(reviewRoot, "diff"));
  await mkdir(runtimeDir);
  await writeFile(join(reviewRoot, "diff/pr.diff"), "");
  await writeFile(join(reviewRoot, "diff/numstat.txt"), "");
  await installGitDiffShim(reviewRoot, runtimeDir);
  await writeTokenPlanConfig(runtimeDir);
  await writeFile(
    join(reviewRoot, ".rejudge/config.json"),
    JSON.stringify({
      reviewers: CENTRAL_CONFIG.reviewers.map((m) => `${m.model}@${m.level}`),
      judge: `${CENTRAL_CONFIG.judge.model}@${CENTRAL_CONFIG.judge.level}`,
      debugLog: false,
    }),
  );
  const input = {
    reviewRoot,
    runtimeDir,
    prompt: "fresh-request",
    outputInstructions: "output-exact-json",
  };
  return { dir, input };
}
function canaries() {
  for (const [key, value] of Object.entries({
    QWEN_TOKEN_PLAN_API_KEY: "sk-sp-qwen-canary",
    QWEN_API_KEY: "legacy-key-canary",
    BAILIAN_TOKEN_PLAN_API_KEY: "bailian-key-canary",
    ALIBABA_WORKSPACE_ID: "workspace-canary",
    GITHUB_TOKEN: "github-canary",
    LINEAR_CLIENT_SECRET: "linear-canary",
    LINEAR_CLIENT_ID: "linear-id",
    AWS_SECRET_ACCESS_KEY: "aws-canary",
    NODE_OPTIONS: "--import consumer-code",
  }))
    vi.stubEnv(key, value);
}
async function childFixture(dir: string, code: string) {
  const script = join(dir, "fixture.mjs");
  await writeFile(script, code);
  vi.mocked(nodeSpawn).mockImplementation((...args: Parameters<typeof nodeSpawn>) => {
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toHaveLength(1);
    expect(args[1]).not.toContain("--unsafe");
    expect(args[1]).not.toContain("--full");
    expect(String(args[1]?.[0]).replaceAll("\\", "/")).toMatch(
      /\/src\/review-engine\/rejudge-worker\.js$/,
    );
    return actualSpawn(process.execPath, [script], args[2]);
  });
}
it("receives a single real child response with no parent credentials or Node injection", async () => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(
    dir,
    `let request='';for await(const part of process.stdin)request+=part;process.stdout.write(JSON.stringify({schema_version:1,ok:true,answer:JSON.stringify({env:process.env,request:JSON.parse(request),cwd:process.cwd()}),run_id:${JSON.stringify(id)}})+'\\n');`,
  );
  const answer = await createRejudgeEngine().fresh(input);
  const observed = JSON.parse(answer.answer);
  expect(observed.env.QWEN_TOKEN_PLAN_API_KEY).toBe("sk-sp-qwen-canary");
  for (const key of ["QWEN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY", "ALIBABA_WORKSPACE_ID"])
    expect(observed.env[key]).toBeUndefined();
  expect(observed.env.NODE_OPTIONS).toBeUndefined();
  expect(answer.answer).not.toMatch(
    /github-canary|linear-canary|linear-id|aws-canary|consumer-code/,
  );
  expect(observed.cwd).toBe(input.reviewRoot);
  expect(observed.request).toEqual({
    schema_version: 1,
    mode: "fresh",
    review_root: input.reviewRoot,
    runtime_dir: input.runtimeDir,
    prompt: "fresh-request",
    output_instructions: "output-exact-json",
  });
  expect(nodeSpawn).toHaveBeenCalledTimes(1);
});
it.each([
  "process.stdout.write('not-json\\n')",
  "process.stdout.write('{}\\n')",
  `process.stdout.write(JSON.stringify({schema_version:1,ok:true,answer:'answer',run_id:'bad'})+'\\n')`,
  `process.stdout.write(JSON.stringify({schema_version:1,ok:true,answer:'answer',run_id:${JSON.stringify(id)},extra:true})+'\\n')`,
  `process.stdout.write(JSON.stringify({schema_version:1,ok:true,answer:'answer',run_id:${JSON.stringify(id)}})+'\\nnoise\\n')`,
  "process.exit(9)",
])("maps malformed/nonzero real child output to technical failure: %s", async (code) => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(dir, code);
  await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({
    reason: "REJUDGE_PANEL_FAILED",
    stage: "setup",
    model: null,
  });
  expect(nodeSpawn).toHaveBeenCalledTimes(1);
});
it.each(["timeout", "abort"])("kills a real pending child on %s without retry", async (kind) => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(dir, "setInterval(()=>{},1000)");
  const controller = new AbortController();
  const engine = createRejudgeEngine({
    deadline: Date.now() + (kind === "timeout" ? 100 : 10000),
    signal: controller.signal,
  });
  const promise = engine.fresh(input);
  if (kind === "abort") setTimeout(() => controller.abort(), 100);
  await expect(promise).rejects.toMatchObject({ reason: "REJUDGE_PANEL_FAILED", stage: "setup" });
  expect(nodeSpawn).toHaveBeenCalledTimes(1);
});
it("preserves owned stage/model failures but never carries raw child diagnostics in errors", async () => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(
    dir,
    "process.stderr.write('private-provider-body Bearer sk-sp-qwen-canary github-canary');process.stdout.write(JSON.stringify({schema_version:1,ok:false,stage:'judge',model:'qwen-token-plan/qwen3.8-max',message:'provider sk-sp-qwen-canary'})+'\\n');",
  );
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({
      reason: "REJUDGE_JUDGE_FAILED",
      stage: "judge",
      model: "qwen-token-plan/qwen3.8-max",
      message: "REJUDGE_JUDGE_FAILED",
    });
    expect(JSON.stringify(stderr.mock.calls)).not.toMatch(
      /private-provider-body|sk-sp-qwen-canary|github-canary/,
    );
  } finally {
    stderr.mockRestore();
  }
});
async function actualWorker(
  dir: string,
  input: { runtimeDir: string },
  unconfined = false,
  providerError?: string,
) {
  const extension = pathToFileURL(
    createRequire(import.meta.url).resolve("rejudge/dist/extension.js"),
  ).href;
  const pi = import.meta.resolve("@earendil-works/pi-coding-agent");
  const sourceRoot = new URL("../../src/", import.meta.url).href;
  const hook = join(dir, "session-hook.mjs");
  const facade = `export * from ${JSON.stringify(pi)};
 import {appendFileSync} from 'node:fs';import {join} from 'node:path';
 const trace=value=>appendFileSync(join(process.env.AI_PR_REVIEW_RUNTIME,'trace.jsonl'),JSON.stringify(value)+'\\n');
 export async function createAgentSession(options){
 process.stdout.write("UPSTREAM_PROGRESS sk-sp-qwen-canary");process.stderr.write("UPSTREAM_DIAGNOSTIC sk-sp-qwen-canary");
 const {model,sessionManager:manager}=options;
 const messages=manager.getEntries().filter(e=>e.type==='message').map(e=>e.message);
 trace({event:'session',model:model.id,maxTokens:model.maxTokens,level:options.thinkingLevel,tools:options.tools,customTools:options.customTools.map(t=>t.name),resumed:messages.length>0,env:process.env,cwd:options.cwd});
 return {session:{state:{messages},subscribe(){return ()=>{};},dispose(){},abort(){},getLastAssistantText(){return [...messages].reverse().find(m=>m.role==='assistant')?.content[0].text;},async prompt(text){
 trace({event:'prompt',model:model.id,text});
 const answer={role:'assistant',content:[{type:'text',text:'answer: '+text}],api:'openai-completions',provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
 const user={role:'user',content:text,timestamp:Date.now()};manager.appendMessage(user);manager.appendMessage(answer);messages.push(user,answer);
 if (${JSON.stringify(providerError)} !== undefined) { answer.stopReason='error'; answer.errorMessage=${JSON.stringify(providerError)}; }
 }}};
 }`;
  await writeFile(
    hook,
    `import {registerHooks} from 'node:module';import {existsSync} from 'node:fs';import {fileURLToPath,pathToFileURL} from 'node:url';
 const facade='data:text/javascript,'+encodeURIComponent(${JSON.stringify(facade)});
 registerHooks({resolve(specifier,context,next){
 if(${unconfined}&&specifier===${JSON.stringify(pi)}&&context.parentURL?.endsWith("/pi-confinement-contract.ts"))return {url:'data:text/javascript,'+encodeURIComponent('export * from '+${JSON.stringify(JSON.stringify(pi))}+';export function createReadToolDefinition(){return {name:"read",execute:async()=>({content:[]})};}'),shortCircuit:true};
 if(specifier==='@earendil-works/pi-coding-agent'&&context.parentURL===${JSON.stringify(extension)})return {url:facade,shortCircuit:true};
 let url;try{url=new URL(specifier,context.parentURL).href;}catch{}
 if(url?.startsWith(${JSON.stringify(sourceRoot)})&&url.endsWith('.js')&&existsSync(fileURLToPath(url.slice(0,-3)+'.ts')))return {url:url.slice(0,-3)+'.ts',shortCircuit:true};
 return next(specifier,context);
 }});`,
  );
  vi.mocked(nodeSpawn).mockImplementation((...args: Parameters<typeof nodeSpawn>) =>
    actualSpawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(hook).href,
        fileURLToPath(new URL("../../src/review-engine/rejudge-worker.ts", import.meta.url)),
      ],
      args[2],
    ),
  );
  return join(input.runtimeDir, "trace.jsonl");
}
it("executes shipped fresh and two judge-only resumes in the same confined runtime", async () => {
  canaries();
  const { dir, input } = await layout();
  const trace = await actualWorker(dir, input);
  await mkdir(join(input.reviewRoot, "target/.rejudge"), { recursive: true });
  await mkdir(join(input.reviewRoot, "target/.pi/extensions"), { recursive: true });
  await writeFile(
    join(input.reviewRoot, "target/.rejudge/config.json"),
    JSON.stringify({ reviewers: ["evil/one"], judge: "evil/two" }),
  );
  await writeFile(
    join(input.reviewRoot, "target/.pi/extensions/evil.js"),
    "throw Error('CONSUMER_EXTENSION_EXECUTED')",
  );
  const engine = createRejudgeEngine();
  const fresh = await engine.fresh(input);
  expect(fresh.run_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{1,8}$/);
  const repair = await engine.resume({ ...input, runId: fresh.run_id, prompt: "repair-request" });
  const closure = await engine.resume({ ...input, runId: fresh.run_id, prompt: "closure-request" });
  expect(fresh.answer).toContain("fresh-request");
  expect(repair.answer).toContain("repair-request");
  expect(closure.answer).toContain("closure-request");
  expect(repair.run_id).toBe(fresh.run_id);
  expect(closure.run_id).toBe(fresh.run_id);
  // The deployment platform uses TMPDIR; Windows Node uses TEMP/TMP instead.
  if (process.platform !== "win32") {
    const manifest = JSON.parse(
      await readFile(
        join(input.runtimeDir, "tmp/rejudge/runs", fresh.run_id, "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.cwd).toBe(input.reviewRoot);
    expect(manifest.runId).toBe(fresh.run_id);
    expect(manifest.fullTools).toBe(false);
    expect(manifest.reviewers).toHaveLength(3);
    for (const ref of [...manifest.reviewers, manifest.judge]) {
      expect(ref.file.startsWith(join(input.runtimeDir, "tmp") + "/")).toBe(true);
      await expect(readFile(ref.file, "utf8")).resolves.toContain('"role":"assistant"');
    }
  }
  const raw = await readFile(trace, "utf8");
  expect(raw).not.toMatch(/github-canary|linear-canary|linear-id|aws-canary|consumer-code/);
  const events = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const prompts = events.filter((e) => e.event === "prompt");
  expect(prompts).toHaveLength(6);
  expect(prompts.filter((e) => e.model !== "qwen3.8-max")).toHaveLength(3);
  const sessions = events.filter((e) => e.event === "session");
  expect(sessions).toHaveLength(12);
  for (const session of sessions) {
    expect(session.cwd).toBe(input.reviewRoot);
    expect(session.maxTokens).toBe(session.model === "qwen3.8-max" ? 24576 : 32768);
    expect(session.level).toBe(
      session.model === "qwen3.8-max"
        ? "xhigh"
        : session.model === "qwen3.8-flash"
          ? "medium"
          : "high",
    );
    expect(session.env.TMPDIR).toBe(join(input.runtimeDir, "tmp"));
    expect(session.env.PI_CODING_AGENT_DIR).toBe(join(input.runtimeDir, "pi-agent"));
    expect(session.env.AI_PR_REVIEW_RUNTIME).toBe(input.runtimeDir);
    expect(session.env.QWEN_TOKEN_PLAN_API_KEY).toBe("sk-sp-qwen-canary");
    expect(session.tools).toEqual(
      session.model === "qwen3.8-max" ? ["ask_panel"] : ["read", "grep", "find", "ls", "git_diff"],
    );
    expect(session.customTools).toEqual(
      session.model === "qwen3.8-max" ? ["ask_panel"] : ["git_diff"],
    );
  }
  expect(sessions.filter((e) => e.resumed)).toHaveLength(8);
  await expect(
    engine.resume({ ...input, runtimeDir: join(dir, "other-runtime"), runId: fresh.run_id }),
  ).rejects.toMatchObject({ stage: "resume" });
  await expect(engine.fresh(input)).rejects.toMatchObject({ stage: "setup" });
  expect(nodeSpawn).toHaveBeenCalledTimes(3);
}, 30000);

it("never treats a malformed resume as a fresh panel request", async () => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(dir, "process.exit(0)");
  await expect(
    createRejudgeEngine().resume({ ...input, runId: undefined as unknown as string }),
  ).rejects.toMatchObject({ stage: "resume" });
  expect(nodeSpawn).not.toHaveBeenCalled();
});

it("carries a real shipped provider failure through the worker without diagnostic bodies", async () => {
  canaries();
  const { dir, input } = await layout();
  await actualWorker(dir, input, false, "429 insufficient_quota private-provider-body");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({
      reason: "PROVIDER_QUOTA_EXHAUSTED",
      stage: "panel",
      message: "PROVIDER_QUOTA_EXHAUSTED",
    });
    expect(JSON.stringify(stderr.mock.calls)).not.toMatch(
      /private-provider-body|insufficient_quota/,
    );
  } finally {
    stderr.mockRestore();
  }
}, 30000);

it("rejects unknown provider codes from the child protocol", async () => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(
    dir,
    "process.stdout.write(JSON.stringify({schema_version:1,ok:false,stage:'panel',model:null,message:'private',provider_reason:'PROVIDER_INVENTED'})+'\\n')",
  );
  await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({
    reason: "REJUDGE_PANEL_FAILED",
  });
});

it("rejects a missing local key with a provider code before spawning", async () => {
  canaries();
  const { input } = await layout();
  vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", undefined);
  await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({
    reason: "PROVIDER_CONFIG_INVALID",
  });
  expect(nodeSpawn).not.toHaveBeenCalled();
});
it("rejects a child failure whose stage is not a string", async () => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(
    dir,
    "process.stdout.write(JSON.stringify({schema_version:1,ok:false,stage:['judge'],model:null,message:'failure'})+'\\n')",
  );
  await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({ stage: "setup" });
});
it("shares and clamps the original 50-minute job deadline across resume calls", async () => {
  canaries();
  const { dir, input } = await layout();
  await childFixture(
    dir,
    `for await(const part of process.stdin){};process.stdout.write(JSON.stringify({schema_version:1,ok:true,answer:'answer',run_id:${JSON.stringify(id)}})+'\\n')`,
  );
  const now = Date.now();
  const engine = createRejudgeEngine({ deadline: now + 60 * 60 * 1000 });
  await engine.fresh(input);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 50 * 60 * 1000 + 1);
  try {
    await expect(engine.resume({ ...input, runId: id })).rejects.toMatchObject({ stage: "resume" });
    expect(nodeSpawn).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
it("rejects pre-aborted work without creating a child", async () => {
  canaries();
  const { input } = await layout();
  const controller = new AbortController();
  controller.abort();
  await expect(
    createRejudgeEngine({ signal: controller.signal }).fresh(input),
  ).rejects.toMatchObject({ stage: "setup" });
  expect(nodeSpawn).not.toHaveBeenCalled();
});
it("redacts and bounds worker diagnostics while requiring matching fresh/resume metadata", () => {
  canaries();
  const diagnostic = vi.fn();
  parseRejudgeResult(
    result(
      "rejudge failed: judge (qwen-token-plan/qwen3.8-max) failed: sk-sp-qwen-canary " +
        "x".repeat(10000),
    ),
    "fresh",
    undefined,
    diagnostic,
  );
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]![0]).not.toContain("sk-sp-qwen-canary");
  expect(diagnostic.mock.calls[0]![0].length).toBeLessThanOrEqual(2048);
  expect(parseRejudgeResult(result("answer\n" + metadata), "resume", id)).toMatchObject({
    ok: false,
  });
  expect(
    parseRejudgeResult(
      result(`answer\nRun ID: ${id} (resumed). Follow up again with resumeRunId: "${id}".`),
      "fresh",
    ),
  ).toMatchObject({ ok: false });
});

it("fails before any model session when actual Pi confinement attestation fails", async () => {
  canaries();
  const { dir, input } = await layout();
  const trace = await actualWorker(dir, input, true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(createRejudgeEngine().fresh(input)).rejects.toMatchObject({ stage: "setup" });
    await expect(readFile(trace, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(stderr.mock.calls)).toContain("PI_CONFINEMENT_CONTRACT_FAILED");
  } finally {
    stderr.mockRestore();
  }
});
