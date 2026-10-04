import type { ReviewRequest } from "../contracts/review-request.js";
import { parseReviewRequest } from "../contracts/review-request.js";
import type { GitHubReader } from "../github/preflight-reader.js";
import { runPreflight } from "./preflight-pipeline.js";
import {
  runReviewPipeline,
  type PrepareDependencies,
  type ExecuteDependencies,
  type ReviewInput,
  type ReviewPipelineResult,
} from "./review-pipeline.js";

// Resolve transport metadata before the engine. No webhook, Actions, or installation
// credential handling lives in the review pipeline.
export async function resolveReviewRequest(
  request: ReviewRequest,
  engineSha: string,
  workDir: string,
  reader: GitHubReader,
): Promise<ReviewInput> {
  parseReviewRequest(JSON.stringify(request));
  const preflight = await runPreflight(
    {
      mode: "manual",
      integration: "app",
      repository: request.repository,
      prNumber: request.prNumber,
      actor: request.trigger.actor,
      engineSha,
      expectedHeadSha: request.headSha,
      requirementsSource: request.requirementsSource,
    },
    reader,
  );
  if (
    preflight.base_sha !== null &&
    (preflight.base_sha !== request.baseSha || preflight.base_branch !== request.baseBranch)
  )
    preflight.status = "STALE_SKIPPED";
  return { preflight, workDir, optionalConfig: true };
}
export async function runRequestedReview(
  request: ReviewRequest,
  engineSha: string,
  workDir: string,
  prepare: PrepareDependencies,
  execute: ExecuteDependencies,
): Promise<ReviewPipelineResult> {
  const input = await resolveReviewRequest(request, engineSha, workDir, prepare.github);
  return runReviewPipeline(input, prepare, execute);
}
