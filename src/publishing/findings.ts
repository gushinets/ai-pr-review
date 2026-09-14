import { createHash } from "node:crypto";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { FindingBasis } from "../contracts/common.js";
import type { JudgeResultV1 } from "../contracts/judge-result.js";
import type { ReviewIdentityV1 } from "../contracts/review-identity.js";
import type { ReviewFindingV1 } from "../contracts/review-state.js";
import type { DiffIndex } from "../contracts/review-context.js";

const MAX_GITHUB_BODY_BYTES = 60_000;
const basisLabels: Record<FindingBasis, string> = {
  code: "Code",
  ci: "CI",
  requirements: "Requirements",
  policy: "Policy",
};
const safeTextEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "@": "&#64;",
  "\\": "&#92;",
  "`": "&#96;",
  "*": "&#42;",
  _: "&#95;",
  "~": "&#126;",
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "#": "&#35;",
  "!": "&#33;",
  ":": "&#58;",
  "/": "&#47;",
};

export function buildReviewFindings(
  result: JudgeResultV1,
  identity: ReviewIdentityV1,
  diff: DiffIndex,
): ReviewFindingV1[] {
  return result.findings.map((finding, sourceIndex) => ({
    ...finding,
    finding_id: createHash("sha256")
      .update(
        `${identity.repository}\n${identity.pr_number}\n${identity.head_sha}\n${sourceIndex}\n` +
          `${finding.severity}\n${finding.title}\n${finding.location?.path ?? ""}\n${finding.location?.line ?? ""}\n${finding.location?.side ?? ""}`,
      )
      .digest("hex")
      .slice(0, 24),
    source_index: sourceIndex,
    publication_location:
      finding.location !== null && diff.contains(finding.location) ? finding.location : null,
  }));
}

export function findingFingerprint(headSha: string, finding: ReviewFindingV1): string {
  return createHash("sha256")
    .update(
      `${headSha}\n${finding.finding_id}\n${finding.publication_location?.path ?? ""}\n${finding.publication_location?.line ?? ""}\n${finding.publication_location?.side ?? ""}`,
    )
    .digest("hex")
    .slice(0, 24);
}

function normalizeForPresentation(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

// Encode Markdown punctuation as entities so model prose remains text even outside an HTML block.
export function renderSafeText(text: string): string {
  return [...normalizeForPresentation(text)]
    .map((char) => {
      if (char === "\n") return "<br>";
      if (char === "\t") return "&#9;";
      return safeTextEscapes[char] ?? char;
    })
    .join("");
}

export function renderProse(text: string): string {
  return `<p>${renderSafeText(text)}</p>`;
}

export function renderCode(text: string): string {
  return `<code>${renderSafeText(text)}</code>`;
}

// Kept as a compatibility alias for callers that used the old helper; prose is no longer preformatted.
export function renderText(text: string, _maxBytes?: number): string {
  return renderProse(text);
}

function severityLabel(finding: ReviewFindingV1): string {
  return finding.severity === "blocking" ? "🔴 Blocking" : "🟡 Non-blocking";
}

function confidenceLabel(finding: ReviewFindingV1): string {
  return `${finding.confidence[0]!.toUpperCase()}${finding.confidence.slice(1)} confidence`;
}

function basisLabel(finding: ReviewFindingV1): string {
  return finding.basis.map((basis) => basisLabels[basis]).join(" · ");
}

function fullFinding(finding: ReviewFindingV1): string {
  return [
    `<strong>${severityLabel(finding)}</strong> · <strong>${confidenceLabel(finding)}</strong>`,
    `Basis: ${basisLabel(finding)}`,
    "",
    "<strong>Title</strong>",
    `<strong>${renderSafeText(finding.title)}</strong>`,
    "",
    "<strong>Evidence</strong>",
    renderProse(finding.evidence),
    "",
    "<strong>Why this matters</strong>",
    renderProse(finding.rationale),
    "",
    "<strong>Suggested fix</strong>",
    renderProse(finding.remediation),
  ].join("\n");
}

function oversizedFinding(finding: ReviewFindingV1): string {
  return [
    `<strong>${severityLabel(finding)}</strong> · <strong>${confidenceLabel(finding)}</strong>`,
    `Basis: ${basisLabel(finding)}`,
    "",
    "<strong>Exceptional size condition</strong>",
    renderProse("Finding is too large for safe GitHub inline publication."),
    renderProse("Full sanitized detail is retained in the canonical review artifact."),
  ].join("\n");
}

export function renderFinding(finding: ReviewFindingV1): string {
  const rendered = fullFinding(finding);
  return Buffer.byteLength(rendered, "utf8") <= MAX_GITHUB_BODY_BYTES
    ? rendered
    : oversizedFinding(finding);
}

export function renderInlineFinding(headSha: string, finding: ReviewFindingV1): string {
  const marker = `<!-- ${CENTRAL_CONFIG.findingMarkerPrefix}:${findingFingerprint(headSha, finding)} -->`;
  const rendered = `${renderFinding(finding)}\n\n${marker}`;
  if (Buffer.byteLength(rendered, "utf8") <= MAX_GITHUB_BODY_BYTES) return rendered;
  return `${oversizedFinding(finding)}\n\n${marker}`;
}
