import { createHash } from "node:crypto";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { ReviewStateV1 } from "../contracts/review-state.js";
import { renderCode, renderFinding, renderProse, renderSafeText } from "./findings.js";

const MAX_SUMMARY_BYTES = 60_000;
const MAX_VISIBLE_LINEAR_ISSUE_BYTES = 256;
const SIZE_NOTICE = [
  "<strong>Exceptional size condition</strong>",
  renderProse(
    "Presentation details were reduced because the GitHub summary reached its safe size limit.",
  ),
  renderProse("Full sanitized detail is retained in the canonical review artifact."),
  renderProse("Technical details are retained in the canonical review artifact."),
].join("\n");

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

export function verdictFeedbackMarker(headSha: string, verdict: "correct" | "incorrect"): string {
  return `<!-- ai-pr-review-verdict-feedback:v1:${headSha}:${verdict} -->`;
}

function visibleCounts(state: ReviewStateV1): string {
  const blocking = state.findings.filter((finding) => finding.severity === "blocking").length;
  return `**${state.findings.length} findings** · ${blocking} blocking · ${state.findings.length - blocking} non-blocking`;
}

function visibleLinearIssue(linearIssue: string | null): string {
  const value = linearIssue ?? "unknown";
  if (Buffer.byteLength(value, "utf8") <= MAX_VISIBLE_LINEAR_ISSUE_BYTES) return renderCode(value);
  return renderCode(
    `[oversized Linear identifier omitted (${Buffer.byteLength(value, "utf8")} bytes)]`,
  );
}

function hasOversizedLinearIssue(linearIssue: string | null): boolean {
  return (
    linearIssue !== null && Buffer.byteLength(linearIssue, "utf8") > MAX_VISIBLE_LINEAR_ISSUE_BYTES
  );
}

function visibleCiCounts(state: ReviewStateV1): string {
  if (state.ci_summary === null) return "CI: ⚠️ unavailable";
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
  if (checks.length === 0) return "CI: ⚠️ no checks";
  if (success === checks.length) return `CI: ✅ ${success}/${checks.length} successful`;
  const other = checks.length - success - failure - pending;
  return `CI: ${success}/${checks.length} successful · ${failure} failed · ${pending} pending · ${other} other`;
}

function outcomeHeading(state: ReviewStateV1): string {
  if (state.outcome === "PASS") return "## AI PR Review — ✅ PASS";
  if (state.outcome === "BLOCK") return "## AI PR Review — 🔴 BLOCK";
  return "## AI PR Review — ⚠️ UNABLE TO REVIEW";
}

function visibleHeader(state: ReviewStateV1): string {
  const historical =
    state.resolution_result === null ? [] : [`Historical blockers: ${historicalCounts(state)}`];
  return [
    outcomeHeading(state),
    "Verdict: " + state.outcome,
    visibleCounts(state),
    `Head: ${renderCode(state.attempt_identity.head_sha)} · Linear: ${visibleLinearIssue(state.lineage.linear_issue)}`,
    visibleCiCounts(state),
    ...historical,
    ...(state.unable_reason === null ? [] : [`Unable reason: ${state.unable_reason}`]),
  ].join("\n\n");
}

function findingIcon(severity: "blocking" | "non_blocking"): string {
  return severity === "blocking" ? "🔴" : "🟡";
}

function findingSeverity(severity: "blocking" | "non_blocking"): string {
  return severity === "blocking" ? "Blocking" : "Non-blocking";
}

function findingConfidence(confidence: "high" | "medium" | "low"): string {
  return `${confidence[0]!.toUpperCase()}${confidence.slice(1)} confidence`;
}

function findingBasis(basis: ReviewStateV1["findings"][number]["basis"]): string {
  return basis
    .map(
      (item) => ({ code: "Code", ci: "CI", requirements: "Requirements", policy: "Policy" })[item],
    )
    .join(" · ");
}

function findingIndex(finding: ReviewStateV1["findings"][number], index: number): string {
  return [
    `#### ${findingIcon(finding.severity)} ${index + 1}. ${renderSafeText(finding.title)}`,
    `<strong>${findingSeverity(finding.severity)}</strong> · ${findingConfidence(finding.confidence)}`,
    `Basis: ${findingBasis(finding.basis)}`,
    ...(finding.publication_location === null
      ? []
      : [renderCode(`${finding.publication_location.path}:${finding.publication_location.line}`)]),
  ].join("\n");
}

function findingDetails(finding: ReviewStateV1["findings"][number], open: boolean): string {
  return [
    `<details${open ? " open" : ""}>`,
    "<summary>Full finding</summary>",
    "",
    renderFinding(finding),
    "",
    "</details>",
  ].join("\n");
}

function formatDuration(durationMs: number): string {
  let seconds = Math.floor(Math.max(0, durationMs) / 1000);
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) return `${hours}h ${remainingMinutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function tokenValue(value: number | null): string {
  return value === null ? "unknown" : value.toLocaleString("en-US");
}

function technicalDetails(state: ReviewStateV1): string {
  const telemetry = state.telemetry;
  const modelPanel = telemetry.models.length
    ? telemetry.models.map((model) => {
        const status = model.status ?? "unknown";
        const duration =
          model.duration_ms === undefined
            ? "unknown"
            : model.duration_ms === null
              ? "n/a"
              : formatDuration(model.duration_ms);
        return `- ${model.role}: <code>${renderSafeText(model.model_id)}</code> · Requested reasoning: ${renderSafeText(model.requested_reasoning)} · Effective reasoning: ${renderSafeText(model.effective_reasoning ?? "unknown")} · Status: ${renderSafeText(status)} · Duration: ${renderSafeText(duration)}`;
      })
    : ["- No model records available."];
  return [
    "<details>",
    "<summary>Technical details</summary>",
    "",
    "<strong>Runtime</strong>",
    `- Rejudge status: ${renderSafeText(telemetry.rejudge_status)}`,
    `- Failed stage: ${renderSafeText(telemetry.rejudge_failed_stage ?? "none")}`,
    `- Duration: ${formatDuration(telemetry.duration_ms)}`,
    `- Judge repair count: ${telemetry.judge_repair_attempts}`,
    `- Closure used: ${telemetry.closure_used ? "yes" : "no"}`,
    `- Input tokens: ${tokenValue(telemetry.input_tokens)}`,
    `- Output tokens: ${tokenValue(telemetry.output_tokens)}`,
    "",
    "<strong>Model panel</strong>",
    ...modelPanel,
    "",
    "</details>",
  ].join("\n");
}

function historicalCounts(state: ReviewStateV1): string {
  const resolutions = state.resolution_result!.resolutions;
  const statuses = ["resolved", "still_present", "invalidated", "uncertain"] as const;
  const counts = statuses
    .map((status) => `${status}: ${resolutions.filter((item) => item.status === status).length}`)
    .join("; ");
  return counts;
}

function historicalDetails(state: ReviewStateV1): string {
  const resolutions = state.resolution_result!.resolutions;
  const details = resolutions.length
    ? resolutions
        .map((resolution) =>
          [
            `<strong>Previous finding</strong>: ${renderSafeText(resolution.previous_finding_id)}`,
            `<strong>Status</strong>: ${renderSafeText(resolution.status)}`,
            "<strong>Evidence</strong>",
            renderProse(resolution.evidence),
          ].join("\n"),
        )
        .join("\n\n")
    : "No historical blockers recorded.";
  return [
    "### Historical blockers",
    `**${resolutions.length} historical blockers** · ${historicalCounts(state)}`,
    "",
    "<details>",
    "<summary>Historical blocker details</summary>",
    "",
    details,
    "",
    "</details>",
  ].join("\n");
}

function feedbackDetails(state: ReviewStateV1): string {
  const head = state.attempt_identity.head_sha;
  return [
    "<details>",
    "<summary>How to provide Stage 1 feedback</summary>",
    "",
    "Only users with write, maintain or admin repository permission at evaluation time count as authorized feedback. React to this summary: 👍 correct / 👎 incorrect PR-level verdict. On blocking inline findings: 👍 finding valid / 👎 false positive. Feedback never changes the verdict. After a summary update, remove and re-add your reaction to label this reviewed head.",
    "",
    "If a human finds a material blocker after AI PASS, post a PR comment with this exact marker. An authorized user's exact marker is required; discussion prose alone does not count.",
    "",
    `To persist exact-head verdict feedback, an authorized human with write, maintain or admin repository permission must post exactly one of these markers after this review: \`${verdictFeedbackMarker(head, "correct")}\` or \`${verdictFeedbackMarker(head, "incorrect")}\`. Contradictory markers remain unlabeled; reactions are convenience only.`,
    "",
    `If needed, post this exact material-miss marker as a separate PR comment: ${renderCode(`<!-- ai-pr-review-material-miss:v1:${head} -->`)}`,
    "",
    "</details>",
  ].join("\n");
}

function bytes(parts: string[]): number {
  return Buffer.byteLength(parts.join("\n\n"), "utf8");
}

function assemble(
  state: ReviewStateV1,
  overview: string | null,
  anchored: Array<string | null>,
  unanchored: Array<string | null>,
  historical: string | null,
  technical: string | null,
  notice: string | null,
  includeIndex: boolean,
): string[] {
  const findings = ["### Findings"];
  if (state.findings.length === 0) findings.push("No findings reported.");
  else if (includeIndex) {
    for (const [index, finding] of state.findings.entries()) {
      findings.push(findingIndex(finding, index));
      const detail = finding.publication_location === null ? unanchored[index] : anchored[index];
      if (detail !== null && detail !== undefined) findings.push(detail);
    }
  } else {
    findings.push(
      `**${state.findings.length} findings**`,
      "Finding titles were omitted because the report reached the safe GitHub summary size limit.",
    );
    for (const [index, finding] of state.findings.entries()) {
      const detail = finding.publication_location === null ? unanchored[index] : anchored[index];
      if (detail !== null && detail !== undefined) findings.push(detail);
    }
  }
  return [
    CENTRAL_CONFIG.summaryMarker,
    calibrationMarker(state),
    visibleHeader(state),
    ...(overview === null ? [] : ["### Overview", overview]),
    ...findings,
    ...(historical === null ? [] : [historical]),
    ...(technical === null ? [] : [technical]),
    feedbackDetails(state),
    ...(notice === null ? [] : [notice]),
  ];
}

export function renderSummary(state: ReviewStateV1): string {
  const overview = state.judge_result === null ? null : renderProse(state.judge_result.summary);
  const anchored = state.findings.map((finding) =>
    finding.publication_location === null ? null : findingDetails(finding, false),
  );
  const unanchored = state.findings.map((finding) =>
    finding.publication_location === null ? findingDetails(finding, true) : null,
  );
  const historical = state.resolution_result === null ? null : historicalDetails(state);
  const technical = technicalDetails(state);
  const empty: Array<string | null> = state.findings.map(() => null);
  const sizeNotice = hasOversizedLinearIssue(state.lineage.linear_issue) ? SIZE_NOTICE : null;
  const complete = assemble(
    state,
    overview,
    anchored,
    unanchored,
    historical,
    technical,
    sizeNotice,
    true,
  );
  if (bytes(complete) <= MAX_SUMMARY_BYTES)
    return complete
      .join("\n\n")
      .replace(`${CENTRAL_CONFIG.summaryMarker}\n\n`, `${CENTRAL_CONFIG.summaryMarker}\n`);

  let includeIndex =
    bytes(assemble(state, null, empty, empty, null, null, SIZE_NOTICE, true)) <= MAX_SUMMARY_BYTES;
  let selectedUnanchored = [...empty];
  let selectedAnchored = [...empty];
  let selectedOverview: string | null = null;
  let selectedHistorical: string | null = null;
  let selectedTechnical: string | null = null;
  const fits = (
    nextOverview: string | null,
    nextAnchored: Array<string | null>,
    nextUnanchored: Array<string | null>,
    nextHistorical: string | null,
    nextTechnical: string | null,
    nextIndex: boolean,
  ) =>
    bytes(
      assemble(
        state,
        nextOverview,
        nextAnchored,
        nextUnanchored,
        nextHistorical,
        nextTechnical,
        SIZE_NOTICE,
        nextIndex,
      ),
    ) <= MAX_SUMMARY_BYTES;

  // ponytail: bounded O(n²) reassembly for at most 20 findings; byte accounting is unnecessary here.
  for (const [index, detail] of unanchored.entries()) {
    if (detail !== null) {
      const next = [...selectedUnanchored];
      next[index] = detail;
      if (fits(null, selectedAnchored, next, null, null, includeIndex)) selectedUnanchored = next;
    }
  }
  for (const [index, detail] of anchored.entries()) {
    if (detail !== null) {
      const next = [...selectedAnchored];
      next[index] = detail;
      if (fits(null, next, selectedUnanchored, null, null, includeIndex)) selectedAnchored = next;
    }
  }
  if (
    overview !== null &&
    fits(overview, selectedAnchored, selectedUnanchored, null, null, includeIndex)
  )
    selectedOverview = overview;
  if (
    historical !== null &&
    fits(selectedOverview, selectedAnchored, selectedUnanchored, historical, null, includeIndex)
  )
    selectedHistorical = historical;
  if (
    technical !== null &&
    fits(
      selectedOverview,
      selectedAnchored,
      selectedUnanchored,
      selectedHistorical,
      technical,
      includeIndex,
    )
  )
    selectedTechnical = technical;

  if (
    !fits(
      selectedOverview,
      selectedAnchored,
      selectedUnanchored,
      selectedHistorical,
      selectedTechnical,
      includeIndex,
    )
  ) {
    selectedTechnical = null;
    selectedHistorical = null;
    selectedAnchored = [...empty];
    if (!fits(selectedOverview, selectedAnchored, selectedUnanchored, null, null, includeIndex))
      selectedOverview = null;
    if (!fits(selectedOverview, selectedAnchored, selectedUnanchored, null, null, includeIndex))
      selectedUnanchored = [...empty];
    if (!fits(selectedOverview, selectedAnchored, selectedUnanchored, null, null, includeIndex))
      includeIndex = false;
  }
  const parts = assemble(
    state,
    selectedOverview,
    selectedAnchored,
    selectedUnanchored,
    selectedHistorical,
    selectedTechnical,
    SIZE_NOTICE,
    includeIndex,
  );
  return parts
    .join("\n\n")
    .replace(`${CENTRAL_CONFIG.summaryMarker}\n\n`, `${CENTRAL_CONFIG.summaryMarker}\n`);
}
