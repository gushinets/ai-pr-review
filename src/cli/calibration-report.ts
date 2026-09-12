import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import {
  calibrationCriteria,
  collectCalibration,
  type CalibrationResult,
} from "../orchestration/calibration.js";

export function renderCalibration({ report: r, coverage: c }: CalibrationResult): string {
  return [
    `# AI review calibration: ${r.repository}`,
    `Observation window (UTC): ${c.window_start} through ${c.window_end}.`,
    [
      "| Criterion | Current | Required | Result |",
      "| --- | ---: | ---: | --- |",
      ...calibrationCriteria(r).map(
        (item) =>
          `| ${item.name} | ${item.value ?? "unknown"} | ${item.threshold} | ${item.pass ? "PASS" : "FAIL"} |`,
      ),
    ].join("\n"),
    `Stage 2 criteria met: ${r.stage2_criteria_met ? "yes (advisory)" : "no"}.`,
    `p50 latency ms: ${r.p50_latency_ms ?? "unknown"}.`,
    `Input tokens: ${r.total_input_tokens}; output tokens: ${r.total_output_tokens}; token usage samples: ${r.token_usage_samples}/${c.canonical_attempts}. Totals include only reported fields; missing usage is unknown.`,
    `Provider failures (canonical UNABLE outcomes): ${Object.entries(r.provider_failures)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join("; ")}.`,
    "Provider failures are diagnostic, not a separate Stage-2 criterion. Engineering owners should review repeated quota/concurrency failures.",
    `Observed trusted terminal attempts: ${c.trusted_terminal_attempts}; distinct canonical attempts: ${c.canonical_attempts}; reused artifacts: ${c.reused_artifacts}.`,
    `Missing attempted reviews: ${c.missing_attempts} (technical inability, not fabricated canonical UNABLE states); excluded stale/nonattempt runs: ${c.excluded_runs}; pending: ${c.pending_runs}.`,
    `Latency observations: ${c.latency_observations}/${r.completed_live_reviews}. Incomplete latency distributions remain unknown.`,
    "Quality denominators include only unambiguous authorized feedback. Unlabeled silence is excluded; a PASS dislike alone is not a material miss. See docs/calibration.md for denominator rules and coverage limits.",
    "Known security violations are operator-supplied; default 0 means no incidents supplied, not an audit or proof of absence.",
    "Engineering-owner approval is still required before changing required checks.",
  ].join("\n\n");
}

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  makeClient: (token: string) => Octokit = (token) =>
    new Octokit({ auth: token, log: { debug() {}, info() {}, warn() {}, error() {} } }),
): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        repository: { type: "string" },
        "json-out": { type: "string" },
        "known-security-boundary-violations": { type: "string" },
      },
    });
    const incidents = values["known-security-boundary-violations"] ?? "0";
    if (!/^(0|[1-9][0-9]*)$/.test(incidents)) throw new Error("CALIBRATION_INPUT_INVALID");
    const result = await collectCalibration(
      makeClient(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? ""),
      values.repository ?? "",
      Number(incidents),
    );
    if (values["json-out"] !== undefined)
      await writeFile(resolve(values["json-out"]), `${JSON.stringify(result.report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    console.log(renderCalibration(result));
    return 0;
  } catch {
    console.error("CALIBRATION_REPORT_FAILED");
    return 70;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
