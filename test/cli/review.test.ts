import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const head = "a".repeat(40),
  base = "b".repeat(40),
  engine = "c".repeat(40);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-cli-"));
  temps.push(root);
  const trace = join(root, "trace"),
    loader = join(root, "loader.mjs"),
    worker = join(root, "worker.mjs");
  await writeFile(
    worker,
    `import { appendFileSync } from 'node:fs';
    if (process.env.GITHUB_TOKEN || process.env.LINEAR_CLIENT_ID || process.env.LINEAR_CLIENT_SECRET || !process.env.QWEN_API_KEY) process.exit(9);
    let data=''; for await(const chunk of process.stdin) data+=chunk;
    const request=JSON.parse(data);
    appendFileSync(${JSON.stringify(trace)},'worker-safe\\n');
    process.stdout.write(JSON.stringify({schema_version:1,ok:true,answer:JSON.stringify({schema_version:1,summary:'Done',findings:[]}),run_id:'2026-09-11T01-02-03-004Z-abc123'})+'\\n');`,
  );
  await writeFile(
    loader,
    `import { registerHooks, createRequire, syncBuiltinESMExports } from 'node:module';
    import { readFileSync, existsSync, appendFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import childProcess from 'node:child_process';
    const require=createRequire(import.meta.url), ts=require(${JSON.stringify(require.resolve("typescript"))});
    registerHooks({resolve(s,c,n){if(s.endsWith('.js')&&c.parentURL?.startsWith('file:')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(u))return {url:u.href,shortCircuit:true};}return n(s,c);},load(u,c,n){if(u.endsWith('.ts'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(u),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};return n(u,c);}});
    const spawn=childProcess.spawn;
    childProcess.spawn=(exe,args,opts)=>{if(args[0]?.endsWith('rejudge-worker.js')) return spawn(exe,[${JSON.stringify(worker)}],opts); throw Error('Unexpected child');}; syncBuiltinESMExports();
    let pulls=0; const record=x=>appendFileSync(${JSON.stringify(trace)},x+'\\n');
    globalThis.fetch=async(input, options={})=>{
      const url=typeof input==='string'?input:input.url;
      record(url);
      const phase=process.argv[2];
      if(phase==='prepare' && (!process.env.LINEAR_CLIENT_SECRET || process.env.QWEN_API_KEY || process.env.ALIBABA_WORKSPACE_ID)) throw Error('prepare-env');
      if(phase==='execute' && (process.env.LINEAR_CLIENT_SECRET || process.env.LINEAR_CLIENT_ID || !process.env.QWEN_API_KEY)) throw Error('execute-env');
      if(phase==='emit-preflight-unable' && (process.env.LINEAR_CLIENT_SECRET || process.env.QWEN_API_KEY)) throw Error('emit-env');
      const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
      if(url.includes('/oauth/token')) return json({access_token:'oauth-canary',token_type:'Bearer',expires_in:3600,scope:'read'});
      if(url.includes('api.linear.app/graphql')) return json({data:{issue:{id:'issue',sharedAccess:{sharedWithUsers:[]},reactions:[],identifier:'ANY-1',title:'Private linear title',description:'Credentials echoed linear-secret-canary github-canary',comments:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}});
      if(url.includes('/actions/artifacts')) return json({total_count:0,artifacts:[]});
      if(url.includes('/contents/')) return json({type:'file',encoding:'base64',content:Buffer.from(url.includes('ai-review.yml')?'version: 1\\nprimary_ci_workflow: CI\\npolicy:\\n  always: [AGENTS.md]\\n  scoped: []\\n':'Trusted base policy').toString('base64')});
      if(url.includes('/check-runs')) return json({total_count:0,check_runs:[]});
      if(url.includes('/status')) return json({sha:'${head}',total_count:0,statuses:[]});
      if(url.includes('/actions/runs')) return json({total_count:0,workflow_runs:[]});
      if(url.includes('/tarball/')) {const {gzipSync}=require('node:zlib');return new Response(gzipSync(readFileSync(${JSON.stringify(resolve("fixtures/security/archive-inert.tar"))})));}
      if(url.includes('/pulls/1/files')) return json([{filename:'run.sh',status:'modified',additions:1,deletions:1}]);
      if(url.includes('/pulls/1')) {
        const headers=options.headers instanceof Headers?options.headers:new Headers(options.headers);
        if(headers.get('accept')?.includes('diff')) return new Response('diff --git a/run.sh b/run.sh\\n--- a/run.sh\\n+++ b/run.sh\\n@@ -1 +1 @@\\n-old\\n+UNTRUSTED_HEAD\\n',{headers:{'content-type':'text/plain; charset=utf-8'}});
        pulls++; const currentHead=Number(process.env.TEST_STALE_AT)===pulls?'f'.repeat(40):'${head}';
        return json({number:1,state:'open',title:'ANY-1 - Change',body:'',user:{login:'owner'},base:{ref:'main',sha:'${base}',repo:{full_name:'o/r'}},head:{sha:currentHead},changed_files:1,additions:1,deletions:1});
      }
      if(url==='https://api.github.com/repos/o/r') return json({default_branch:'main'});
      throw Error('Unexpected network request');
    };`,
  );
  const workDir = join(root, "ai-pr-review"),
    stateOut = join(workDir, "out/ai-review-state-v1.json");
  async function run(phase: string, extraEnv: NodeJS.ProcessEnv = {}, extraArgs: string[] = []) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      HOME: root,
      RUNNER_TEMP: root,
      GITHUB_TOKEN: "github-canary",
      GITHUB_OUTPUT: join(root, "output"),
      ...extraEnv,
    };
    const args = [
      "--import",
      pathToFileURL(loader).href,
      resolve("src/cli/review.ts"),
      phase,
      "--repository",
      "o/r",
      "--pr-number",
      "1",
      "--base-sha",
      base,
      "--head-sha",
      head,
      "--engine-sha",
      engine,
      "--work-dir",
      workDir,
      "--state-out",
      stateOut,
      ...(phase === "emit-preflight-unable"
        ? ["--unable-reason", "PR_METADATA_INVALID"]
        : ["--linear-issue", "ANY-1"]),
      ...extraArgs,
    ];
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
  }
  return { root, workDir, stateOut, trace, run };
}
const linear = {
  LINEAR_CLIENT_ID: "linear-client-canary",
  LINEAR_CLIENT_SECRET: "linear-secret-canary",
};
const qwen = { QWEN_API_KEY: "qwen-canary", ALIBABA_WORKSPACE_ID: "workspace" };
it("runs production prepare and execute in separate OS processes, including isolated Rejudge child", async () => {
  const f = await fixture();
  const prepared = await f.run("prepare", linear);
  expect(prepared).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(
    await readFile(join(f.root, "output"), "utf8"),
    (await readFile(f.stateOut, "utf8").catch(() => "")) + (await readFile(f.trace, "utf8")),
  ).toBe("action=EXECUTE\n");
  const text = await readFile(join(f.workDir, "private/prepared-review-v1.json"), "utf8");
  expect(text).not.toMatch(/linear-secret-canary|github-canary|oauth-canary|secretValues/);
  const result = await f.run("execute", qwen);
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(JSON.parse(await readFile(f.stateOut, "utf8"))).toMatchObject({ outcome: "PASS" });
  expect(await readFile(f.trace, "utf8")).toContain("worker-safe");
}, 20000);
it("emits preflight UNABLE with no AI or Linear credentials and null review identity", async () => {
  const f = await fixture();
  expect(await f.run("emit-preflight-unable")).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(JSON.parse(await readFile(f.stateOut, "utf8"))).toMatchObject({
    outcome: "UNABLE_TO_REVIEW",
    unable_reason: "PR_METADATA_INVALID",
    review_identity: null,
  });
});
it.each(["", "bad/workspace", "workspace\n"])(
  "rejects workspace %j before first model call",
  async (workspace) => {
    const f = await fixture();
    expect((await f.run("prepare", linear)).code).toBe(0);
    expect(await readFile(join(f.root, "output"), "utf8")).toBe("action=EXECUTE\n");
    const result = await f.run("execute", { ...qwen, ALIBABA_WORKSPACE_ID: workspace });
    expect(result.stdout).toBe("");
    expect(await readFile(f.trace, "utf8")).not.toContain("worker-safe");
    expect(JSON.parse(await readFile(f.stateOut, "utf8"))).toMatchObject({
      outcome: "UNABLE_TO_REVIEW",
    });
  },
  20000,
);
it.each([
  ["prepare", { ...linear, ...qwen }],
  ["execute", { ...linear, ...qwen }],
  ["emit-preflight-unable", qwen],
] as const)("rejects mixed phase credentials for %s", async (phase, env) => {
  const f = await fixture();
  const result = await f.run(phase, env);
  expect(result.code).toBeGreaterThanOrEqual(70);
  expect(result.stdout).toBe("");
  await expect(readFile(f.trace, "utf8")).rejects.toThrow();
});

it.each([false, true])(
  "removes old canonical output and emits no state when final head is stale (unable=%s)",
  async (unable) => {
    const f = await fixture();
    expect((await f.run("prepare", linear)).code).toBe(0);
    await writeFile(f.stateOut, "obsolete-state");
    const result = await f.run("execute", {
      ...qwen,
      TEST_STALE_AT: "3",
      ...(unable ? { ALIBABA_WORKSPACE_ID: "invalid/workspace" } : {}),
    });
    expect(result).toEqual({ code: 20, stdout: "", stderr: "" });
    await expect(readFile(f.stateOut, "utf8")).rejects.toThrow();
  },
  20000,
);
it("rejects untrusted output paths before any GitHub or credential access", async () => {
  const f = await fixture();
  const result = await f.run("prepare", linear, ["--state-out", join(f.root, "outside.json")]);
  expect(result.code).toBeGreaterThanOrEqual(70);
  await expect(readFile(f.trace, "utf8")).rejects.toThrow();
});
