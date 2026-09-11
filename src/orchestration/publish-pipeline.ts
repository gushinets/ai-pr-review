import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { ReviewStateV1 } from "../contracts/review-state.js";
import { retryRead } from "../github/github-client.js";
import type { GitHubPublisher } from "../github/publisher.js";
import { findingFingerprint, renderInlineFinding } from "../publishing/findings.js";
import { buildMachineCheck, renderSummary } from "../publishing/summary.js";
import { parseReviewState } from "../state/review-state.js";

export type PublishWarning =
  "SUMMARY_PUBLICATION_FAILED" | "INLINE_PUBLICATION_FAILED" | "PRESENTATION_STALE_SKIPPED";
export interface PublishResult {
  status: "PUBLISHED" | "STALE_SKIPPED";
  warnings: PublishWarning[];
}

export async function runPublish(
  input: ReviewStateV1,
  github: GitHubPublisher,
): Promise<PublishResult> {
  const state = parseReviewState(JSON.stringify(input));
  const { repository, pr_number: prNumber, head_sha: headSha } = state.attempt_identity;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(prNumber))
    throw new Error("STATE_LOAD_FAILED");
  const stale = new Error("STALE_SKIPPED");
  const requireHead = async () => {
    if ((await github.getHead(repository, prNumber)) !== headSha) throw stale;
  };
  const check = buildMachineCheck(state);
  let checkWriteAttempted = false;
  try {
    await requireHead();
    await retryRead(async () => {
      const checks = await github.listChecks(repository, headSha);
      const existing = checks.find(
        (item) =>
          item.name === check.name &&
          item.head_sha === headSha &&
          item.external_id === check.external_id,
      );
      await requireHead();
      checkWriteAttempted = true;
      await github.writeCheck(repository, check, existing?.id);
    });
  } catch (error) {
    if (error === stale && !checkWriteAttempted) return { status: "STALE_SKIPPED", warnings: [] };
    throw new Error("CHECK_PUBLICATION_FAILED");
  }
  const result: PublishResult = { status: "PUBLISHED", warnings: [] };
  try {
    const body = renderSummary(state);
    await retryRead(async () => {
      const comments = await github.listSummaries(repository, prNumber);
      const existing = comments.find(
        (comment) =>
          comment.body === CENTRAL_CONFIG.summaryMarker ||
          comment.body.startsWith(`${CENTRAL_CONFIG.summaryMarker}\n`),
      );
      await requireHead();
      await github.writeSummary(repository, prNumber, body, existing?.id);
    });
  } catch (error) {
    if (error === stale) {
      result.warnings.push("PRESENTATION_STALE_SKIPPED");
      return result;
    }
    result.warnings.push("SUMMARY_PUBLICATION_FAILED");
  }
  try {
    await retryRead(async () => {
      const existing = await github.listInline(repository, prNumber);
      const comments = state.findings.flatMap((finding) => {
        if (finding.publication_location === null) return [];
        const marker = `<!-- ${CENTRAL_CONFIG.findingMarkerPrefix}:${findingFingerprint(headSha, finding)} -->`;
        if (
          existing.some(
            (comment) =>
              comment.original_commit_id === headSha && comment.body.endsWith(`\n\n${marker}`),
          )
        )
          return [];
        return [{ ...finding.publication_location, body: renderInlineFinding(headSha, finding) }];
      });
      if (comments.length === 0) return;
      await requireHead();
      await github.writeInline(repository, prNumber, headSha, comments);
    });
  } catch (error) {
    result.warnings.push(
      error === stale ? "PRESENTATION_STALE_SKIPPED" : "INLINE_PUBLICATION_FAILED",
    );
  }
  return result;
}
