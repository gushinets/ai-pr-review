import { createHash } from "node:crypto";
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
