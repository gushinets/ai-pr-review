import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import {
  isProviderFailureReason,
  type ProviderFailureReason,
  type UnableReason,
} from "../contracts/failure-reasons.js";
import { buildWorkerEnv } from "../sandbox/worker-env.js";
import {
  parseWorkerRequest,
  RUN_ID_PATTERN,
  safeWorkerDiagnostic,
  type RejudgeWorkerRequest,
  type RejudgeWorkerResponse,
} from "./rejudge-worker.js";

interface RunInput {
  reviewRoot: string;
  runtimeDir: string;
  prompt: string;
  outputInstructions: string;
}
export interface RejudgeRun {
  answer: string;
  run_id: string;
}
export interface RejudgeEngine {
  fresh(input: RunInput): Promise<RejudgeRun>;
  resume(input: RunInput & { runId: string }): Promise<RejudgeRun>;
}
export class RejudgeEngineError extends Error {
  readonly reason:
    Extract<UnableReason, "REJUDGE_PANEL_FAILED" | "REJUDGE_JUDGE_FAILED"> | ProviderFailureReason;
  readonly stage: "setup" | "panel" | "judge" | "resume";
  readonly model: string | null;
  constructor(
    stage: "setup" | "panel" | "judge" | "resume",
    model: string | null = null,
    providerReason?: ProviderFailureReason,
  ) {
    const reason =
      providerReason ??
      (stage === "setup" || stage === "panel" ? "REJUDGE_PANEL_FAILED" : "REJUDGE_JUDGE_FAILED");
    super(reason);
    this.reason = reason;
    this.stage = stage;
    this.model = model;
  }
}
function parseResponse(text: string): RejudgeWorkerResponse {
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1)
    throw new Error("INVALID_WORKER_RESPONSE");
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_WORKER_RESPONSE");
  const v = value as Record<string, unknown>;
  const keys =
    v.ok === true
      ? ["schema_version", "ok", "answer", "run_id"]
      : [
          "schema_version",
          "ok",
          "stage",
          "model",
          "message",
          ...(v.provider_reason === undefined ? [] : ["provider_reason"]),
        ];
  if (
    v.schema_version !== 1 ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((key) => !keys.includes(key))
  )
    throw new Error("INVALID_WORKER_RESPONSE");
  if (
    v.ok === true &&
    typeof v.answer === "string" &&
    typeof v.run_id === "string" &&
    RUN_ID_PATTERN.test(v.run_id)
  )
    return v as RejudgeWorkerResponse;
  if (
    v.ok === false &&
    typeof v.stage === "string" &&
    ["setup", "panel", "judge", "resume"].includes(v.stage) &&
    (v.model === null || typeof v.model === "string") &&
    typeof v.message === "string" &&
    (v.provider_reason === undefined || isProviderFailureReason(v.provider_reason))
  )
    return v as RejudgeWorkerResponse;
  throw new Error("INVALID_WORKER_RESPONSE");
}
export function createRejudgeEngine(
  options: {
    deadline?: number;
    signal?: AbortSignal;
    diagnostic?: (message: string) => void;
  } = {},
): RejudgeEngine {
  const deadline = Math.min(
    options.deadline ?? Infinity,
    Date.now() + CENTRAL_CONFIG.reviewTimeoutMs,
  );
  const attempts = new Map<string, { runtimeDir: string; runId?: string; busy: boolean }>();
  const diagnostic =
    options.diagnostic ?? ((message: string) => process.stderr.write(`${message}\n`));
  async function execute(input: RunInput, runId?: string): Promise<RejudgeRun> {
    const stage = runId === undefined ? "setup" : "resume";
    const fail = () => new RejudgeEngineError(stage);
    const previous = attempts.get(input.reviewRoot);
    if (!Number.isFinite(deadline) || Date.now() >= deadline || options.signal?.aborted)
      throw fail();
    if (runId === undefined) {
      if (previous) throw fail();
      attempts.set(input.reviewRoot, { runtimeDir: input.runtimeDir, busy: true });
    } else if (
      !RUN_ID_PATTERN.test(runId) ||
      !previous ||
      previous.busy ||
      previous.runtimeDir !== input.runtimeDir ||
      previous.runId !== runId
    )
      throw fail();
    const attempt = attempts.get(input.reviewRoot)!;
    attempt.busy = true;
    try {
      const request: RejudgeWorkerRequest = parseWorkerRequest({
        schema_version: 1,
        mode: runId === undefined ? "fresh" : "resume",
        review_root: input.reviewRoot,
        runtime_dir: input.runtimeDir,
        prompt: input.prompt,
        output_instructions: input.outputInstructions,
        ...(runId === undefined ? {} : { resume_run_id: runId }),
      });
      const env = await buildWorkerEnv(input);
      if (Date.now() >= deadline || options.signal?.aborted) throw fail();
      const response = await new Promise<RejudgeWorkerResponse>((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
        let stdout = "",
          stderr = "",
          oversized = false,
          childError = false;
        const clean = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        };
        try {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("./rejudge-worker.js", import.meta.url))],
            {
              shell: false,
              cwd: input.reviewRoot,
              env,
              stdio: ["pipe", "pipe", "pipe"],
              signal: controller.signal,
              killSignal: "SIGKILL",
            },
          );
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 4 * 1024 * 1024) {
              oversized = true;
              abort();
            } else stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            if (stderr.length + chunk.length > 64 * 1024) {
              oversized = true;
              abort();
            } else stderr += chunk;
          });
          child.on("error", () => {
            childError = true;
          });
          child.stdin.on("error", () => {
            childError = true;
          });
          child.on("close", (code) => {
            clean();
            // Never persist provider errors or expose child output in the owned error object.
            if (stderr && !oversized) {
              const code = stderr.trim();
              diagnostic(
                isProviderFailureReason(code) || code === "PI_CONFINEMENT_CONTRACT_FAILED"
                  ? code
                  : "Rejudge worker diagnostic",
              );
            }
            if (code !== 0 || childError || oversized || controller.signal.aborted) {
              reject(fail());
              return;
            }
            try {
              resolve(parseResponse(stdout));
            } catch {
              reject(fail());
            }
          });
          child.stdin.end(JSON.stringify(request) + "\n");
        } catch {
          clean();
          reject(fail());
        }
      });
      if (!response.ok)
        throw new RejudgeEngineError(
          response.stage,
          response.model === null ? null : safeWorkerDiagnostic(response.model),
          response.provider_reason,
        );
      if (runId !== undefined && response.run_id !== runId) throw fail();
      attempt.runId = response.run_id;
      return { answer: response.answer, run_id: response.run_id };
    } catch (error) {
      if (error instanceof Error && error.message === "PROVIDER_CONFIG_INVALID")
        throw new RejudgeEngineError(stage, null, "PROVIDER_CONFIG_INVALID");
      throw error instanceof RejudgeEngineError ? error : fail();
    } finally {
      attempt.busy = false;
    }
  }
  return {
    fresh: (input) => execute(input),
    resume: async (input) => {
      if (typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId))
        throw new RejudgeEngineError("resume");
      return execute(input, input.runId);
    },
  };
}
