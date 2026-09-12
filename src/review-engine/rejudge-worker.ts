import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { ProviderFailureReason } from "../contracts/failure-reasons.js";
import { sanitizeCiLog } from "../github/ci-context.js";
import { assertPiConfinementContract } from "../sandbox/pi-confinement-contract.js";
import { buildWorkerEnv } from "../sandbox/worker-env.js";
import { loadRejudgeTool } from "./rejudge-extension.js";

export type RejudgeWorkerRequest = {
  schema_version: 1;
  review_root: string;
  runtime_dir: string;
  prompt: string;
  output_instructions: string;
} & ({ mode: "fresh" } | { mode: "resume"; resume_run_id: string });
export type RejudgeWorkerResponse =
  | { schema_version: 1; ok: true; answer: string; run_id: string }
  | {
      schema_version: 1;
      ok: false;
      stage: "setup" | "panel" | "judge" | "resume";
      model: string | null;
      message: string;
      provider_reason?: ProviderFailureReason;
    };
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{1,8}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const failure = (
  stage: "setup" | "panel" | "judge" | "resume" = "setup",
  model: string | null = null,
): RejudgeWorkerResponse => ({
  schema_version: 1,
  ok: false,
  stage,
  model,
  message: "Rejudge execution failed",
});

function providerFailure(model: string, detail: string): ProviderFailureReason | undefined {
  if (
    ![...CENTRAL_CONFIG.reviewers, CENTRAL_CONFIG.judge].some((m) => m.model === model) ||
    !/^(?:empty-output retry )?did not complete cleanly \(stopReason: error\)(?::|$)/.test(detail)
  )
    return undefined;
  if (/\b(?:invalid_api_key|authentication_error)\b/i.test(detail)) return "PROVIDER_AUTH_FAILED";
  if (
    /\b(?:insufficient_quota|resource[_ -]exhausted)\b|\b(?:quota|credits?)\b.{0,40}\b(?:exhausted|depleted|insufficient|exceeded)\b|\binsufficient\s+(?:quota|credits?)\b/i.test(
      detail,
    )
  )
    return "PROVIDER_QUOTA_EXHAUSTED";
  if (/\b(?:401|403|unauthorized|forbidden)\b/i.test(detail)) return "PROVIDER_AUTH_FAILED";
  if (/\b429\b/.test(detail)) return "PROVIDER_RATE_LIMITED";
  return "PROVIDER_UNAVAILABLE";
}
export function parseWorkerRequest(value: unknown): RejudgeWorkerRequest {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    (value.mode !== "fresh" && value.mode !== "resume")
  )
    throw new Error("INVALID_WORKER_REQUEST");
  const keys = [
    "schema_version",
    "mode",
    "review_root",
    "runtime_dir",
    "prompt",
    "output_instructions",
    ...(value.mode === "resume" ? ["resume_run_id"] : []),
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    ["review_root", "runtime_dir", "prompt", "output_instructions"].some(
      (key) => typeof value[key] !== "string",
    ) ||
    !isAbsolute(value.review_root as string) ||
    !isAbsolute(value.runtime_dir as string) ||
    (value.mode === "resume" &&
      (typeof value.resume_run_id !== "string" || !RUN_ID_PATTERN.test(value.resume_run_id)))
  )
    throw new Error("INVALID_WORKER_REQUEST");
  return value as RejudgeWorkerRequest;
}
export function safeWorkerDiagnostic(
  value: string,
  secrets: readonly string[] = Object.entries(process.env)
    .filter(([key]) => /TOKEN|SECRET|KEY|PASSWORD|PROXY/i.test(key))
    .map(([, value]) => value ?? ""),
): string {
  return sanitizeCiLog(value, secrets).slice(0, 2048);
}
export function parseRejudgeResult(
  value: unknown,
  mode: "fresh" | "resume",
  resumeRunId?: string,
  diagnostic: (text: string) => void = () => {},
): RejudgeWorkerResponse {
  if (
    !record(value) ||
    !Array.isArray(value.content) ||
    value.content.length !== 1 ||
    !record(value.content[0]) ||
    value.content[0].type !== "text" ||
    typeof value.content[0].text !== "string"
  )
    return failure();
  const text = value.content[0].text;
  if (text.startsWith("rejudge failed:")) {
    const match =
      /^rejudge failed: (panel|judge|resume) \(([^)]+)\) (?:failed: ([\s\S]+)|aborted)$/.exec(
        text.slice(0, 2048),
      );
    const reason = match ? providerFailure(match[2]!, match[3] ?? "") : undefined;
    diagnostic(reason ?? "Rejudge execution failed");
    return match
      ? {
          ...failure(match[1] as "panel" | "judge" | "resume", safeWorkerDiagnostic(match[2]!)),
          ...(reason ? { provider_reason: reason } : {}),
        }
      : failure();
  }
  const lines = text.split("\n"),
    last = lines.pop()!;
  const match =
    /^Run ID: (\S+)(?:\. Follow up with| \(resumed\)\. Follow up again with) resumeRunId: "([^"\n]+)"\.$/.exec(
      last,
    );
  if (
    !match ||
    match[1] !== match[2] ||
    !RUN_ID_PATTERN.test(match[1]!) ||
    lines.some((line) => line.startsWith("Run ID:")) ||
    (mode === "resume") !== last.includes(" (resumed).") ||
    (mode === "resume" && match[1] !== resumeRunId)
  )
    return failure();
  return { schema_version: 1, ok: true, answer: lines.join("\n"), run_id: match[1]! };
}

async function main(): Promise<void> {
  const stdout = process.stdout.write.bind(process.stdout),
    stderr = process.stderr.write.bind(process.stderr);
  // Dependencies may emit warnings/progress. Only this entrypoint owns the protocol streams.
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  const diagnostic = (text: string) => {
    stderr(safeWorkerDiagnostic(text) + "\n");
  };
  let response: RejudgeWorkerResponse;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 4 * 1024 * 1024) throw new Error("WORKER_REQUEST_TOO_LARGE");
      chunks.push(buffer);
    }
    const request = parseWorkerRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      request.review_root !== process.env.AI_PR_REVIEW_ROOT ||
      request.runtime_dir !== process.env.AI_PR_REVIEW_RUNTIME ||
      process.cwd() !== request.review_root
    )
      throw new Error("WORKER_ROOT_MISMATCH");
    const env = await buildWorkerEnv({
      reviewRoot: request.review_root,
      runtimeDir: request.runtime_dir,
    });
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "PI_CODING_AGENT_DIR",
      "TMPDIR",
      "PI_OFFLINE",
      "PI_SKIP_VERSION_CHECK",
      "PI_TELEMETRY",
    ]) {
      if (process.env[key] !== env[key]) throw new Error("WORKER_ENV_MISMATCH");
    }
    const config: unknown = JSON.parse(
      await readFile(join(request.review_root, ".rejudge/config.json"), "utf8"),
    );
    const expected = {
      reviewers: CENTRAL_CONFIG.reviewers.map((m) => `${m.model}@${m.level}`),
      judge: `${CENTRAL_CONFIG.judge.model}@${CENTRAL_CONFIG.judge.level}`,
      debugLog: false,
    };
    if (
      !record(config) ||
      Object.keys(config).length !== 3 ||
      JSON.stringify(config.reviewers) !== JSON.stringify(expected.reviewers) ||
      config.judge !== expected.judge ||
      config.debugLog !== false
    )
      throw new Error("REJUDGE_CONFIG_MISMATCH");
    await assertPiConfinementContract(request.review_root);
    const tool = await loadRejudgeTool();
    const result = await tool.execute(
      "ai-pr-review",
      {
        question: request.prompt,
        outputInstructions: request.output_instructions,
        ...(request.mode === "resume" ? { resumeRunId: request.resume_run_id } : {}),
      },
      undefined,
      undefined,
      { cwd: request.review_root },
    );
    response = parseRejudgeResult(
      result,
      request.mode,
      request.mode === "resume" ? request.resume_run_id : undefined,
      diagnostic,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    diagnostic(
      code === "PI_CONFINEMENT_CONTRACT_FAILED" || code === "PROVIDER_CONFIG_INVALID"
        ? code
        : "Worker setup failed",
    );
    response = {
      ...failure(),
      ...(code === "PROVIDER_CONFIG_INVALID"
        ? { provider_reason: "PROVIDER_CONFIG_INVALID" as const }
        : {}),
    };
  }
  stdout(JSON.stringify(response) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
