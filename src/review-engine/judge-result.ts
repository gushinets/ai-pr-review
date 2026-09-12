import Schema from "typebox/schema";
import {
  JudgeResultV1Schema,
  validateJudgeResult,
  type JudgeResultV1,
} from "../contracts/judge-result.js";
import { buildJudgeOutputInstructions, buildJudgeRepairPrompt } from "../context/review-context.js";
import type { RejudgeEngine } from "./rejudge-engine.js";
import {
  isProviderFailureReason,
  type ProviderFailureReason,
} from "../contracts/failure-reasons.js";

export class JudgeProtocolError extends Error {
  readonly reason = "JUDGE_RESULT_INVALID";
  constructor(path: string, detail: string) {
    super(`JUDGE_RESULT_INVALID at ${path}: ${detail}`);
  }
}

export class JudgeRepairError extends Error {
  readonly reason: "JUDGE_REPAIR_FAILED" | ProviderFailureReason;
  readonly repairAttempts = 1;
  constructor(
    readonly runId: string,
    providerReason?: ProviderFailureReason,
  ) {
    super(providerReason ?? "JUDGE_REPAIR_FAILED");
    this.reason = providerReason ?? "JUDGE_REPAIR_FAILED";
  }
}

export function parseJudgeResult(raw: string): JudgeResultV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new JudgeProtocolError("/", "expected one JSON object");
  }
  const [valid, errors] = Schema.Errors(JudgeResultV1Schema, value);
  if (!valid) {
    // Unknown-property child paths can contain model text; report the owning object instead.
    const error = errors.find((entry) => entry.keyword === "additionalProperties") ?? errors[0];
    throw new JudgeProtocolError(error?.instancePath || "/", "schema mismatch");
  }
  const checked = validateJudgeResult(value);
  if (!checked.ok) {
    const result = value as JudgeResultV1;
    const index = result.findings.findIndex(
      (finding) =>
        !validateJudgeResult({ schema_version: 1, summary: "validation", findings: [finding] }).ok,
    );
    throw new JudgeProtocolError(
      index < 0 ? "/summary" : `/findings/${index}`,
      "semantic invariant failed",
    );
  }
  return checked.value;
}

export async function getValidJudgeResult(
  engine: RejudgeEngine,
  input: { reviewRoot: string; runtimeDir: string; prompt: string },
  validateContext: (result: JudgeResultV1) => void = () => {},
): Promise<{ result: JudgeResultV1; runId: string; repairAttempts: 0 | 1 }> {
  const outputInstructions = buildJudgeOutputInstructions();
  const fresh = await engine.fresh({ ...input, outputInstructions });
  let invalid: JudgeProtocolError;
  try {
    const result = parseJudgeResult(fresh.answer);
    validateContext(result);
    return { result, runId: fresh.run_id, repairAttempts: 0 };
  } catch (error) {
    if (!(error instanceof JudgeProtocolError)) throw error;
    invalid = error;
  }
  try {
    const repaired = await engine.resume({
      ...input,
      outputInstructions,
      runId: fresh.run_id,
      prompt: buildJudgeRepairPrompt(invalid.message),
    });
    if (repaired.run_id !== fresh.run_id) throw new JudgeRepairError(fresh.run_id);
    const result = parseJudgeResult(repaired.answer);
    validateContext(result);
    return { result, runId: fresh.run_id, repairAttempts: 1 };
  } catch (error) {
    const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
    throw new JudgeRepairError(fresh.run_id, isProviderFailureReason(reason) ? reason : undefined);
  }
}
