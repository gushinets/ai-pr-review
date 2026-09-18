import Schema from "typebox/schema";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { ConfigError, loadRepoConfigAtBase } from "../config/repo-config.js";
import { isRepositoryRelativePath } from "../contracts/common.js";
import type { UnableReason } from "../contracts/failure-reasons.js";
import {
  ReviewAttemptIdentityV1Schema,
  type ReviewAttemptIdentityV1,
  type ReviewIdentityV1,
} from "../contracts/review-identity.js";
import { parsePrMetadata } from "../github/pr-metadata.js";
import {
  resolvePullRequest,
  type ChangedFile,
  type GitHubReader,
  type PreflightTrigger,
} from "../github/preflight-reader.js";

export type PreflightInput = PreflightTrigger & { engineSha: string };
export interface PreflightResult {
  schema_version: 1;
  mode: "automatic" | "manual";
  status:
    | "READY"
    | "UNABLE_TO_REVIEW"
    | "STALE_SKIPPED"
    | "UNAUTHORIZED_SKIPPED"
    | "NOT_APPLICABLE_SKIPPED";
  unable_reason: UnableReason | null;
  repository: string;
  pr_number: number | null;
  base_branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  linear_issue: string | null;
  review_attempt_identity: ReviewAttemptIdentityV1 | null;
  review_identity: ReviewIdentityV1 | null;
  changed_files: ChangedFile[];
}
const attemptValidator = Schema.Compile(ReviewAttemptIdentityV1Schema);
const nonnegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
const safeLine = (value: string) =>
  value.length > 0 &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

export function validatePreflightInput(input: PreflightInput): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
    !safeLine(input.repository) ||
    input.engineSha.length !== 40 ||
    !/^[0-9a-fA-F]{40}$/.test(input.engineSha)
  )
    throw new Error("Invalid trusted preflight input");
  const id = input.mode === "automatic" ? input.triggeringRunId : input.prNumber;
  const expectedHeadValid =
    input.mode !== "manual" ||
    input.expectedHeadSha === undefined ||
    /^[0-9a-fA-F]{40}$/.test(input.expectedHeadSha);
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    (input.mode !== "automatic" && input.mode !== "manual") ||
    (input.mode === "manual" &&
      (!input.actor ||
        !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(input.actor) ||
        !safeLine(input.actor) ||
        !expectedHeadValid))
  )
    throw new Error("Invalid preflight trigger");
}

export async function runPreflight(
  input: PreflightInput,
  reader: GitHubReader,
): Promise<PreflightResult> {
  validatePreflightInput(input);
  const result: PreflightResult = {
    schema_version: 1,
    mode: input.mode,
    status: "NOT_APPLICABLE_SKIPPED",
    unable_reason: null,
    repository: input.repository,
    pr_number: input.mode === "manual" ? input.prNumber : null,
    base_branch: null,
    base_sha: null,
    head_sha: null,
    linear_issue: null,
    review_attempt_identity: null,
    review_identity: null,
    changed_files: [],
  };
  const unable = (reason: UnableReason): PreflightResult => ({
    ...result,
    status: "UNABLE_TO_REVIEW",
    unable_reason: reason,
  });
  try {
    const resolution = await resolvePullRequest(input, reader);
    if (resolution.status !== "RESOLVED") return { ...result, status: resolution.status };
    const { pr, workflowName } = resolution;
    const attempt: ReviewAttemptIdentityV1 = {
      repository: input.repository,
      pr_number: pr.number,
      base_sha: pr.baseSha,
      head_sha: pr.headSha,
      engine_sha: input.engineSha,
    };
    if (!attemptValidator.Check(attempt)) return unable("INTERNAL_ERROR");
    result.review_attempt_identity = attempt;
    result.pr_number = pr.number;
    result.base_sha = pr.baseSha;
    result.head_sha = pr.headSha;
    if (!safeLine(pr.baseBranch)) return unable("INTERNAL_ERROR");
    result.base_branch = pr.baseBranch;
    const permission = await reader.getPermission(
      input.repository,
      input.mode === "manual" ? input.actor : pr.author,
    );
    if (!["write", "maintain", "admin"].includes(permission))
      return { ...result, status: "UNAUTHORIZED_SKIPPED" };
    const key = parsePrMetadata(pr.title, pr.body);
    if (!key) return unable("PR_METADATA_INVALID");
    result.linear_issue = key;
    result.review_identity = { ...attempt, linear_issue: key };
    const config = await loadRepoConfigAtBase(pr.baseSha, (path, sha) =>
      reader.readContent(input.repository, path, sha),
    );
    if (input.mode === "automatic" && workflowName !== config.primary_ci_workflow)
      return unable("CONFIG_INVALID");
    if (![pr.changedFiles, pr.additions, pr.deletions].every(nonnegativeInteger))
      return unable("INTERNAL_ERROR");
    if (
      pr.changedFiles > CENTRAL_CONFIG.maxChangedFiles ||
      pr.additions + pr.deletions > CENTRAL_CONFIG.maxChangedLines
    )
      return unable("PR_TOO_LARGE");
    const files = await reader.listChangedFiles(input.repository, pr.number);
    // GitHub's paginated PR files endpoint is mutable; catch a moving head/base before accepting it.
    const current = await reader.getPullRequest(input.repository, pr.number);
    if (current.state !== "open") return { ...result, status: "NOT_APPLICABLE_SKIPPED" };
    if (current.headSha !== pr.headSha || current.baseSha !== pr.baseSha)
      return { ...result, status: "STALE_SKIPPED" };
    if (
      files.some(
        (file) =>
          !isRepositoryRelativePath(file.filename) ||
          !safeLine(file.filename) ||
          !nonnegativeInteger(file.additions) ||
          !nonnegativeInteger(file.deletions) ||
          !safeLine(file.status) ||
          (file.previous_filename !== undefined &&
            (!isRepositoryRelativePath(file.previous_filename) ||
              !safeLine(file.previous_filename))),
      )
    )
      return unable("INTERNAL_ERROR");
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    if (
      files.length > CENTRAL_CONFIG.maxChangedFiles ||
      additions + deletions > CENTRAL_CONFIG.maxChangedLines
    )
      return unable("PR_TOO_LARGE");
    if (
      files.length !== pr.changedFiles ||
      new Set(files.map((file) => file.filename)).size !== files.length ||
      additions !== pr.additions ||
      deletions !== pr.deletions
    )
      return unable("INTERNAL_ERROR");
    result.changed_files = files.map(
      ({ filename, status, additions, deletions, previous_filename }) => ({
        filename,
        status,
        additions,
        deletions,
        ...(previous_filename === undefined ? {} : { previous_filename }),
      }),
    );
    return { ...result, status: "READY" };
  } catch (error) {
    return unable(error instanceof ConfigError ? error.reason : "INTERNAL_ERROR");
  }
}
