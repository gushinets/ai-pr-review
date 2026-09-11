import { createHash } from "node:crypto";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { ReviewStateV1 } from "../contracts/review-state.js";
import { renderFinding, renderText } from "./findings.js";

export interface MachineCheck {
  name: "AI PR Review";
  head_sha: string;
  external_id: string;
  status: "completed";
  conclusion: "success" | "failure";
  output: { title: "AI PR Review"; summary: string };
}

function counts(state: ReviewStateV1): string {
  const blocking = state.findings.filter((finding) => finding.severity === "blocking").length;
  return `Blocking: ${blocking}; non-blocking: ${state.findings.length - blocking}`;
}
function ciCounts(state: ReviewStateV1): string {
  if (state.ci_summary === null) return "CI: unavailable";
  const checks = state.ci_summary.checks;
  const success = checks.filter(
    (check) => check.status === "completed" && check.conclusion === "success",
  ).length;
  const failure = checks.filter(
    (check) =>
      check.status === "completed" &&
      ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(
        check.conclusion ?? "",
      ),
  ).length;
  const pending = checks.filter((check) => check.status !== "completed").length;
  return `CI: ${checks.length} total; ${success} success; ${failure} failure; ${pending} pending; ${checks.length - success - failure - pending} other`;
}
export function buildMachineCheck(state: ReviewStateV1): MachineCheck {
  // All keys are in lexical order: stable JSON for this fixed identity schema.
  const { base_sha, engine_sha, head_sha, pr_number, repository } = state.attempt_identity;
  const external_id = createHash("sha256")
    .update(
      JSON.stringify({
        attempt_identity: { base_sha, engine_sha, head_sha, pr_number, repository },
        linear_issue: state.lineage.linear_issue,
      }),
    )
    .digest("hex");
  return {
    name: CENTRAL_CONFIG.checkName,
    head_sha,
    external_id,
    status: "completed",
    conclusion: state.outcome === "PASS" ? "success" : "failure",
    output: {
      title: CENTRAL_CONFIG.checkName,
      summary: [
        `Outcome: ${state.outcome}`,
        `PR: ${repository}#${pr_number}; head: ${head_sha.slice(0, 12)}`,
        `Linear issue: ${state.lineage.linear_issue ?? "unknown"}`,
        ciCounts(state),
        counts(state),
        ...(state.unable_reason === null ? [] : [`Unable reason: ${state.unable_reason}`]),
      ].join("\n"),
    },
  };
}
export function calibrationMarker(state: ReviewStateV1): string {
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        buildMachineCheck(state).external_id,
        state.telemetry.started_at,
        state.telemetry.finished_at,
      ]),
    )
    .digest("hex");
  return `<!-- ai-pr-review-calibration:v1:${identity} -->`;
}
export function renderSummary(state: ReviewStateV1): string {
  const telemetry = state.telemetry;
  return [
    CENTRAL_CONFIG.summaryMarker,
    calibrationMarker(state),
    `## ${CENTRAL_CONFIG.checkName}`,
    renderText(
      `Verdict: ${state.outcome}\nReviewed head SHA: ${state.attempt_identity.head_sha}\nLinear issue: ${state.lineage.linear_issue ?? "unknown"}\n${ciCounts(state)}\n${counts(state)}${state.unable_reason === null ? "" : `\nUnable reason: ${state.unable_reason}`}`,
    ),
    ...(state.judge_result === null
      ? []
      : ["### Overview", renderText(state.judge_result.summary, 3000)]),
    "### Current findings",
    ...state.findings.map(renderFinding),
    ...(state.resolution_result === null
      ? []
      : [
          "### Historical blockers",
          renderText(
            ["resolved", "still_present", "invalidated", "uncertain"]
              .map(
                (status) =>
                  `${status}: ${state.resolution_result!.resolutions.filter((item) => item.status === status).length}`,
              )
              .join("; "),
          ),
          renderText(
            state.resolution_result.resolutions
              .map(
                (resolution) =>
                  `Previous finding: ${resolution.previous_finding_id}\nStatus: ${resolution.status}\nEvidence: ${resolution.evidence}`,
              )
              .join("\n\n"),
            10000,
          ),
        ]),
    "### Technical completion",
    renderText(
      `Rejudge: ${telemetry.rejudge_status}\nFailed stage: ${telemetry.rejudge_failed_stage ?? "none"}\nDuration ms: ${telemetry.duration_ms}\nJudge repairs: ${telemetry.judge_repair_attempts}\nClosure used: ${telemetry.closure_used}\nInput tokens: ${telemetry.input_tokens ?? "unknown"}\nOutput tokens: ${telemetry.output_tokens ?? "unknown"}\nEstimated cost USD: ${telemetry.estimated_cost_usd ?? "unknown"}`,
    ),
    ...telemetry.models.flatMap((model) => [
      renderText(`Role: ${model.role}\nRequested reasoning: ${model.requested_reasoning}`),
      renderText(`Model ID: ${model.model_id}`, 450),
      renderText(`Effective reasoning: ${model.effective_reasoning ?? "unknown"}`, 450),
    ]),
    "Stage 1 calibration: users with write, maintain or admin permission may react to this summary: 👍 correct / 👎 incorrect PR-level verdict. On blocking inline findings: 👍 finding valid / 👎 false positive. Feedback never changes the verdict. After a summary update, remove and re-add your reaction to label this reviewed head.",
    "If a human finds a material blocker after AI PASS, post a PR comment with this exact marker:",
    renderText(`<!-- ai-pr-review-material-miss:v1:${state.attempt_identity.head_sha} -->`),
  ]
    .join("\n\n")
    .replace(`${CENTRAL_CONFIG.summaryMarker}\n\n`, `${CENTRAL_CONFIG.summaryMarker}\n`);
}
