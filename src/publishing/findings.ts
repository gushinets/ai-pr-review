import { createHash } from "node:crypto";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { JudgeResultV1 } from "../contracts/judge-result.js";
import type { ReviewIdentityV1 } from "../contracts/review-identity.js";
import type { ReviewFindingV1 } from "../contracts/review-state.js";
import type { DiffIndex } from "../contracts/review-context.js";

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

// HTML pre blocks disable Markdown, autolinks and mentions. Escape before wrapping so
// untrusted text cannot close the block or manufacture our hidden control markers.
export function renderText(text: string, maxBytes = 2000): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/@/g, "&#64;")
      .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
  let escaped = text.length <= maxBytes ? escape(text) : "";
  if (text.length > maxBytes || Buffer.byteLength(escaped, "utf8") > maxBytes) {
    // At most six escaped bytes per UTF-16 unit. Keep both ends so canonical
    // trailing history disclosures survive, without interpreting their prose.
    const length = Math.floor((maxBytes - 100) / 12);
    const start = text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
    const end = text.slice(-length).replace(/^[\uDC00-\uDFFF]/u, "");
    escaped = `${escape(start)}\n[Truncated; full detail is in the canonical artifact.]\n${escape(end)}`;
  }
  return `<pre>${escaped}</pre>`;
}
export function renderFinding(finding: ReviewFindingV1): string {
  return [
    renderText(`Severity: ${finding.severity}\nConfidence: ${finding.confidence}`),
    ...(["title", "evidence", "rationale", "remediation"] as const).map((field) =>
      renderText(`${field[0]!.toUpperCase()}${field.slice(1)}: ${finding[field]}`, 450),
    ),
  ].join("\n");
}
export function renderInlineFinding(headSha: string, finding: ReviewFindingV1): string {
  return `${renderFinding(finding)}\n\n<!-- ${CENTRAL_CONFIG.findingMarkerPrefix}:${findingFingerprint(headSha, finding)} -->`;
}
