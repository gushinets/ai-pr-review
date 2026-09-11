import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import Schema from "typebox/schema";
import { Type } from "typebox";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { writeModelStudioConfig } from "../config/model-studio.js";
import { loadRepoConfigAtBase } from "../config/repo-config.js";
import { UNABLE_REASONS, type UnableReason } from "../contracts/failure-reasons.js";
import {
  ReviewContextV1Schema,
  validateReviewContext,
  type ReviewContextV1,
  type DiffLocation,
  type DiffIndex,
} from "../contracts/review-context.js";
import {
  ReviewAttemptIdentityV1Schema,
  validateReviewIdentity,
  type ReviewIdentityV1,
} from "../contracts/review-identity.js";
import {
  ReviewStateV1Schema,
  type ReviewFindingV1,
  type ReviewStateV1,
} from "../contracts/review-state.js";
import {
  buildClosurePrompt,
  buildFreshReviewPrompt,
  buildReviewContext,
} from "../context/review-context.js";
import { buildReviewSnapshot } from "../context/snapshot.js";
import { selectTrustedPolicy } from "../context/trusted-policy.js";
import { loadCiContext } from "../github/ci-context.js";
import {
  buildDiffIndex,
  loadPrDiff,
  StalePrDiffError,
  unifiedDiffSections,
} from "../github/diff.js";
import type { GithubReadClient } from "../github/github-client.js";
import type { LinearRequirementsContextV1 } from "../linear/requirements-loader.js";
import { buildReviewFindings } from "../publishing/findings.js";
import {
  assertDurableValues,
  sanitizeDurableText,
  sanitizeJudgeResult,
  sanitizeResolutionResult,
  type SanitizationSources,
} from "../publishing/sanitize.js";
import {
  getValidJudgeResult,
  JudgeRepairError,
  JudgeProtocolError,
} from "../review-engine/judge-result.js";
import {
  createRejudgeEngine,
  RejudgeEngineError,
  type RejudgeEngine,
} from "../review-engine/rejudge-engine.js";
import {
  parseResolutionResult,
  ResolutionProtocolError,
} from "../review-engine/resolution-result.js";
import { computeFreshVerdict, computeFinalVerdict } from "../review-engine/verdict.js";
import { assertRealpathContained } from "../sandbox/path-containment.js";
import type { StateDiscovery } from "../state/github-artifact-store.js";
import {
  buildReviewState,
  parseReviewState,
  type HistoricalVerificationAvailability,
} from "../state/review-state.js";
import type { PreflightResult } from "./preflight-pipeline.js";

export type ReviewPipelineResult =
  | { kind: "STATE_READY"; state: ReviewStateV1 }
  | { kind: "STALE_SKIPPED" }
  | { kind: "UNAUTHORIZED_SKIPPED" }
  | { kind: "NOT_APPLICABLE_SKIPPED" };
export interface ReviewInput {
  preflight: PreflightResult;
  workDir: string;
}
export interface PrepareDependencies {
  github: GithubReadClient;
  loadState(identity: ReviewIdentityV1, baseBranch: string): Promise<StateDiscovery>;
  loadRequirements(identifier: string): Promise<LinearRequirementsContextV1>;
  secretValues?: string[];
  warn?: (warning: string) => void;
}
export interface ExecuteDependencies {
  github: Pick<GithubReadClient, "getPullRequest">;
  workspaceId: string;
  engine?: RejudgeEngine;
  secretValues?: string[];
  warn?: (warning: string) => void;
}
interface PreparedReview {
  schema_version: 1;
  context: ReviewContextV1;
  history: ReviewStateV1[];
  privateTexts: string[];
  started_at: string;
}
const preparedValidator = Schema.Compile(
  Type.Object(
    {
      schema_version: Type.Literal(1),
      context: ReviewContextV1Schema,
      history: Type.Array(ReviewStateV1Schema),
      privateTexts: Type.Array(Type.String()),
      started_at: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
);
const attemptValidator = Schema.Compile(ReviewAttemptIdentityV1Schema);
const emptyDiff: DiffIndex = { contains: () => false };
const safeText = (text: string) => text.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(text);
const sources = (
  secretValues: string[] = [],
  privateTexts: string[] = [],
): SanitizationSources => ({ secretValues, privateTexts });

function validateInput(input: ReviewInput): void {
  const p = input.preflight,
    attempt = p.review_attempt_identity;
  if (
    !isAbsolute(input.workDir) ||
    !attemptValidator.Check(attempt) ||
    !p.base_branch ||
    !safeText(p.base_branch) ||
    !attempt ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(attempt.repository) ||
    Object.values(attempt).some((value) => typeof value === "string" && !safeText(value)) ||
    p.repository !== attempt.repository ||
    p.pr_number !== attempt.pr_number ||
    p.base_sha !== attempt.base_sha ||
    p.head_sha !== attempt.head_sha ||
    (p.review_identity !== null &&
      (!validateReviewIdentity(p.review_identity).ok ||
        Object.entries(attempt).some(
          ([key, value]) => p.review_identity![key as keyof ReviewIdentityV1] !== value,
        ) ||
        p.linear_issue !== p.review_identity.linear_issue)) ||
    (p.status === "READY" && p.review_identity === null)
  )
    throw new Error("INTERNAL_ERROR");
}
function initialState(
  input: ReviewInput,
  startedAt: string,
): Omit<ReviewStateV1, "schema_version" | "findings"> {
  return {
    attempt_identity: input.preflight.review_attempt_identity!,
    review_identity: input.preflight.review_identity,
    lineage: {
      base_branch: input.preflight.base_branch!,
      linear_issue: input.preflight.review_identity?.linear_issue ?? null,
    },
    outcome: "UNABLE_TO_REVIEW",
    unable_reason: "INTERNAL_ERROR",
    ci_summary: null,
    judge_result: null,
    resolution_result: null,
    previous_review_head_sha: null,
    telemetry: {
      started_at: startedAt,
      finished_at: startedAt,
      duration_ms: 0,
      models: [],
      judge_repair_attempts: 0,
      closure_used: false,
      rejudge_status: "not_started",
      rejudge_failed_stage: null,
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
    },
  };
}
async function finish(
  input: ReviewInput,
  github: ExecuteDependencies["github"],
  state: Omit<ReviewStateV1, "schema_version" | "findings">,
  privacy: SanitizationSources,
  diff = emptyDiff,
  historyAvailability: HistoricalVerificationAvailability = "complete",
): Promise<ReviewPipelineResult> {
  state.telemetry.finished_at = new Date().toISOString();
  state.telemetry.duration_ms = Math.max(0, Date.now() - Date.parse(state.telemetry.started_at));
  // Build first: this barrier is the last external operation before returning an emit-ready state.
  const sanitized = buildReviewState(state, privacy, diff, historyAvailability);
  return (await current(input, github)) ?? { kind: "STATE_READY", state: sanitized };
}
async function current(
  input: ReviewInput,
  github: ExecuteDependencies["github"],
): Promise<ReviewPipelineResult | null> {
  const identity = input.preflight.review_attempt_identity!;
  const pr = await github.getPullRequest(identity.repository, identity.pr_number);
  if (pr.headSha !== identity.head_sha || pr.baseSha !== identity.base_sha)
    return { kind: "STALE_SKIPPED" };
  if (
    pr.number !== identity.pr_number ||
    pr.repository.toLowerCase() !== identity.repository.toLowerCase()
  )
    throw new Error("INTERNAL_ERROR");
  return pr.state === "open" ? null : { kind: "NOT_APPLICABLE_SKIPPED" };
}
function failureReason(error: unknown, fallback: UnableReason): UnableReason {
  return error !== null &&
    typeof error === "object" &&
    "reason" in error &&
    UNABLE_REASONS.includes(error.reason as UnableReason)
    ? (error.reason as UnableReason)
    : fallback;
}
async function owned(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))
  )
    throw new Error("INTERNAL_ERROR");
}
async function privateDirectory(workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await owned(workDir, true);
  const privateDir = join(workDir, "private");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await owned(privateDir, true);
  await assertRealpathContained(workDir, privateDir);
  return privateDir;
}

export async function emitPreflightUnable(
  input: ReviewInput,
  dependencies: Pick<ExecuteDependencies, "github" | "secretValues">,
): Promise<ReviewPipelineResult> {
  validateInput(input);
  const reason = input.preflight.unable_reason;
  if (input.preflight.status !== "UNABLE_TO_REVIEW" || !reason || !UNABLE_REASONS.includes(reason))
    throw new Error("INTERNAL_ERROR");
  const state = initialState(input, new Date().toISOString());
  state.unable_reason = reason;
  return finish(input, dependencies.github, state, sources(dependencies.secretValues));
}

export async function prepareReview(
  input: ReviewInput,
  dependencies: PrepareDependencies,
): Promise<ReviewPipelineResult | { kind: "PREPARED" }> {
  const { preflight: p } = input;
  if (
    p.status === "STALE_SKIPPED" ||
    p.status === "UNAUTHORIZED_SKIPPED" ||
    p.status === "NOT_APPLICABLE_SKIPPED"
  )
    return { kind: p.status };
  validateInput(input);
  if (p.status === "UNABLE_TO_REVIEW") return emitPreflightUnable(input, dependencies);
  const state = initialState(input, new Date().toISOString());
  const privacy = sources(dependencies.secretValues);
  let stage: UnableReason = "STATE_LOAD_FAILED";
  try {
    const discovery = await dependencies.loadState(p.review_identity!, p.base_branch!);
    if (discovery.kind === "reuse") {
      const saved = parseReviewState(JSON.stringify(discovery.state));
      if (
        saved.outcome === "UNABLE_TO_REVIEW" ||
        saved.lineage.base_branch !== p.base_branch ||
        Object.entries(p.review_identity!).some(
          ([key, value]) => saved.review_identity?.[key as keyof ReviewIdentityV1] !== value,
        )
      )
        throw new Error("STATE_LOAD_FAILED");
      assertDurableValues(saved, privacy);
      return (await current(input, dependencies.github)) ?? { kind: "STATE_READY", state: saved };
    }
    stage = "LINEAR_UNAVAILABLE";
    const rawRequirements = await dependencies.loadRequirements(p.review_identity!.linear_issue);
    // Only authorized context crosses the OS boundary. Prepare-process credentials never do.
    const clean = (text: string) => sanitizeDurableText(text, sources(dependencies.secretValues));
    const requirements = {
      ...rawRequirements,
      title: clean(rawRequirements.title),
      description: clean(rawRequirements.description),
      comments: rawRequirements.comments.map((comment) => ({
        created_at: clean(comment.created_at),
        body: clean(comment.body),
      })),
    };
    privacy.privateTexts.push(
      requirements.title,
      requirements.description,
      ...requirements.comments.map((c) => c.body),
    );
    stage = "CONFIG_INVALID";
    const readContent = (path: string, sha: string) =>
      dependencies.github.readContent(p.repository, path, sha);
    const config = await loadRepoConfigAtBase(p.base_sha!, readContent);
    const changedFiles = await dependencies.github.listChangedFiles(p.repository, p.pr_number!);
    stage = "POLICY_MISSING";
    const policy = await selectTrustedPolicy(
      config,
      changedFiles.map((f) => f.filename),
      p.base_sha!,
      readContent,
    );
    stage = "INTERNAL_ERROR";
    const privateDir = await privateDirectory(input.workDir);
    stage = "CI_CONTEXT_UNAVAILABLE";
    const ci = await loadCiContext(
      dependencies.github,
      p.repository,
      p.head_sha!,
      config.primary_ci_workflow,
      privateDir,
      privacy.secretValues,
      dependencies.warn,
    );
    ci.primary_ci_workflow = clean(ci.primary_ci_workflow);
    for (const check of ci.checks) {
      check.name = clean(check.name);
      if (check.details_url !== null) check.details_url = clean(check.details_url);
    }
    state.ci_summary = {
      head_sha: ci.head_sha,
      primary_ci_workflow: ci.primary_ci_workflow,
      checks: ci.checks.map(({ kind, name, status, conclusion }) => ({
        kind,
        name,
        status,
        conclusion,
      })),
    };
    stage = "SNAPSHOT_FAILED";
    const { unifiedDiff } = await loadPrDiff(
      dependencies.github,
      p.repository,
      p.pr_number!,
      p.head_sha!,
    );
    const moved = await current(input, dependencies.github);
    if (moved) return moved;
    const context = buildReviewContext({
      reviewIdentity: p.review_identity!,
      baseBranch: p.base_branch!,
      requirements,
      policy,
      changedFiles,
      ci,
    });
    const snapshot = await buildReviewSnapshot({
      privateDir,
      headArchive: {
        headSha: p.head_sha!,
        stream: await dependencies.github.downloadHeadArchive(p.repository, p.head_sha!),
      },
      context,
      policy,
      requirements,
      unifiedDiff,
      changedFiles,
      ciSourceRoot: privateDir,
    });
    for (const check of snapshot.context.ci.checks)
      if (check.failed_log_path !== null)
        privacy.privateTexts.push(
          await readFile(join(snapshot.reviewRoot, check.failed_log_path), "utf8"),
        );
    stage = "INTERNAL_ERROR";
    const history =
      discovery.previous === null
        ? []
        : [discovery.previous, ...discovery.history.filter((s) => s !== discovery.previous)];
    const prepared: PreparedReview = {
      schema_version: 1,
      context: snapshot.context,
      history,
      privateTexts: privacy.privateTexts,
      started_at: state.telemetry.started_at,
    };
    // Metadata must not smuggle a known credential (including echoed check names or prior artifacts).
    const serialized = JSON.stringify(prepared);
    if (privacy.secretValues.some((secret) => secret && serialized.includes(secret)))
      throw new Error("INTERNAL_ERROR");
    await writeFile(join(privateDir, "prepared-review-v1.json"), serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { kind: "PREPARED" };
  } catch (error) {
    if (error instanceof StalePrDiffError) return { kind: "STALE_SKIPPED" };
    state.unable_reason = failureReason(error, stage);
    return finish(input, dependencies.github, state, privacy);
  }
}

async function readPrepared(input: ReviewInput): Promise<{
  prepared: PreparedReview;
  reviewRoot: string;
  runtimeDir: string;
  diff: DiffIndex;
  containsLocation: (location: DiffLocation | null) => boolean;
}> {
  const privateDir = join(input.workDir, "private"),
    file = join(privateDir, "prepared-review-v1.json");
  await owned(input.workDir, true);
  await owned(privateDir, true);
  await owned(file, false);
  if ((await lstat(file)).size > 64 * 1024 * 1024) throw new Error("INTERNAL_ERROR");
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!preparedValidator.Check(raw)) throw new Error("INTERNAL_ERROR");
  const prepared = raw as PreparedReview;
  if (
    !validateReviewContext(prepared.context).ok ||
    !Number.isFinite(Date.parse(prepared.started_at)) ||
    prepared.context.base_branch !== input.preflight.base_branch ||
    Object.entries(input.preflight.review_identity!).some(
      ([key, value]) => prepared.context.review_identity[key as keyof ReviewIdentityV1] !== value,
    )
  )
    throw new Error("INTERNAL_ERROR");
  for (const state of prepared.history) {
    parseReviewState(JSON.stringify(state));
    if (
      state.outcome === "UNABLE_TO_REVIEW" ||
      state.review_identity?.repository !== input.preflight.repository ||
      state.review_identity.pr_number !== input.preflight.pr_number ||
      state.lineage.base_branch !== input.preflight.base_branch ||
      state.lineage.linear_issue !== input.preflight.linear_issue
    )
      throw new Error("INTERNAL_ERROR");
  }
  const reviewRoot = join(privateDir, "review-root"),
    runtimeDir = join(privateDir, "runtime");
  const targetPaths = new Set<string>();
  // These roots contain only centrally created inert data and runtime files; reject active links.
  async function tree(path: string): Promise<void> {
    await owned(path, true);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await tree(child);
      else {
        await owned(child, false);
        const path = relative(reviewRoot, child).split(sep).join("/");
        if (path.startsWith("target/")) targetPaths.add(path.slice("target/".length));
      }
    }
  }
  await tree(reviewRoot);
  await tree(runtimeDir);
  if (
    JSON.stringify(
      JSON.parse(await readFile(join(reviewRoot, "metadata/review-context.json"), "utf8")),
    ) !== JSON.stringify(prepared.context)
  )
    throw new Error("INTERNAL_ERROR");
  const diff = await readFile(join(reviewRoot, "diff/pr.diff"), "utf8");
  const leftPaths = new Set(unifiedDiffSections(diff).map((section) => section.oldPath));
  const containsLocation = (location: DiffLocation | null) =>
    location === null ||
    targetPaths.has(location.path) ||
    (location.side === "LEFT" && leftPaths.has(location.path));
  return { prepared, reviewRoot, runtimeDir, diff: buildDiffIndex(diff), containsLocation };
}

function previousBlockers(
  history: ReviewStateV1[],
  warn: (message: string) => void,
): { blockers: ReviewFindingV1[]; availability: HistoricalVerificationAvailability } {
  const previous = history[0];
  if (!previous) return { blockers: [], availability: "unavailable" };
  let availability: "incomplete" | "complete" = "complete";
  const blockers = new Map(
    previous.findings.filter((f) => f.severity === "blocking").map((f) => [f.finding_id, f]),
  );
  for (const resolution of previous.resolution_result?.resolutions ?? []) {
    if (resolution.status !== "still_present" && resolution.status !== "uncertain") continue;
    const visited = new Set<ReviewStateV1>();
    let ancestor = previous;
    let found: ReviewFindingV1 | undefined;
    while (!visited.has(ancestor)) {
      visited.add(ancestor);
      found = ancestor.findings.find(
        (f) => f.finding_id === resolution.previous_finding_id && f.severity === "blocking",
      );
      if (found) break;
      const next = history.find(
        (s) => !visited.has(s) && s.attempt_identity.head_sha === ancestor.previous_review_head_sha,
      );
      if (!next) break;
      ancestor = next;
    }
    if (found)
      blockers.set(found.finding_id, {
        ...found,
        location: resolution.current_location,
        publication_location: null,
        evidence: resolution.evidence,
      });
    else {
      availability = "incomplete";
      warn("HISTORICAL_VERIFICATION_UNAVAILABLE");
    }
  }
  return { blockers: [...blockers.values()], availability };
}

export async function executeReview(
  input: ReviewInput,
  dependencies: ExecuteDependencies,
): Promise<ReviewPipelineResult> {
  validateInput(input);
  const state = initialState(input, new Date().toISOString());
  const privacy = sources(dependencies.secretValues);
  let historyAvailability: HistoricalVerificationAvailability = "complete";
  let diff = emptyDiff,
    stage: UnableReason = "INTERNAL_ERROR";
  try {
    const {
      prepared,
      reviewRoot,
      runtimeDir,
      diff: index,
      containsLocation,
    } = await readPrepared(input);
    diff = index;
    privacy.privateTexts = prepared.privateTexts;
    state.telemetry.started_at = prepared.started_at;
    const ci = prepared.context.ci;
    state.ci_summary = {
      head_sha: ci.head_sha,
      primary_ci_workflow: ci.primary_ci_workflow,
      checks: ci.checks.map(({ kind, name, status, conclusion }) => ({
        kind,
        name,
        status,
        conclusion,
      })),
    };
    const moved = await current(input, dependencies.github);
    if (moved) return moved;
    await writeModelStudioConfig(runtimeDir, dependencies.workspaceId);
    const engine =
      dependencies.engine ??
      createRejudgeEngine({
        deadline: Date.parse(prepared.started_at) + CENTRAL_CONFIG.reviewTimeoutMs,
      });
    state.telemetry.models = [...CENTRAL_CONFIG.reviewers, CENTRAL_CONFIG.judge].map(
      (model, i) => ({
        role: (["reviewer_1", "reviewer_2", "reviewer_3", "judge"] as const)[i]!,
        model_id: model.model,
        requested_reasoning: model.level,
        effective_reasoning: null,
      }),
    );
    stage = "REJUDGE_JUDGE_FAILED";
    const fresh = await getValidJudgeResult(
      engine,
      { reviewRoot, runtimeDir, prompt: buildFreshReviewPrompt(prepared.context) },
      (result) => {
        const index = result.findings.findIndex((finding) => !containsLocation(finding.location));
        if (index !== -1)
          throw new JudgeProtocolError(
            `/findings/${index}/location/path`,
            "path absent from reviewed evidence",
          );
      },
    );
    state.telemetry.judge_repair_attempts = fresh.repairAttempts;
    state.telemetry.rejudge_status = "completed";
    stage = "INTERNAL_ERROR";
    state.judge_result = sanitizeJudgeResult(fresh.result, privacy);
    const findings = buildReviewFindings(
      state.judge_result,
      input.preflight.review_identity!,
      diff,
    );
    const { blockers, availability } = previousBlockers(
      prepared.history,
      dependencies.warn ?? (() => {}),
    );
    historyAvailability = availability;
    if (blockers.length) {
      state.previous_review_head_sha = prepared.history[0]!.attempt_identity.head_sha;
      state.telemetry.closure_used = true;
      stage = "CLOSURE_FAILED";
      const prompt = buildClosurePrompt(blockers);
      const closure = await engine.resume({
        reviewRoot,
        runtimeDir,
        runId: fresh.runId,
        prompt,
        outputInstructions: prompt,
      });
      if (closure.run_id !== fresh.runId) throw new Error("CLOSURE_FAILED");
      stage = "CLOSURE_RESULT_INVALID";
      const resolution = parseResolutionResult(
        closure.answer,
        new Set(blockers.map((f) => f.finding_id)),
      );
      stage = "INTERNAL_ERROR";
      if (resolution.resolutions.some((item) => !containsLocation(item.current_location)))
        throw new ResolutionProtocolError("/resolutions", "path absent from reviewed evidence");
      state.resolution_result = sanitizeResolutionResult(resolution, privacy);
    }
    state.outcome = computeFinalVerdict({
      fresh: computeFreshVerdict(findings),
      previousBlockers: blockers,
      resolutions: state.resolution_result,
    });
    state.unable_reason = state.outcome === "UNABLE_TO_REVIEW" ? "CLOSURE_FAILED" : null;
    if (state.outcome === "UNABLE_TO_REVIEW") {
      state.judge_result = null;
      state.resolution_result = null;
    }
  } catch (error) {
    state.outcome = "UNABLE_TO_REVIEW";
    state.unable_reason =
      stage === "CLOSURE_FAILED"
        ? "CLOSURE_FAILED"
        : error instanceof ResolutionProtocolError
          ? "CLOSURE_RESULT_INVALID"
          : failureReason(error, stage);
    state.judge_result = null;
    state.resolution_result = null;
    if (error instanceof JudgeRepairError) state.telemetry.judge_repair_attempts = 1;
    if (state.telemetry.models.length) {
      state.telemetry.rejudge_status = "failed";
      state.telemetry.rejudge_failed_stage =
        state.telemetry.closure_used || error instanceof JudgeRepairError
          ? "resume"
          : error instanceof RejudgeEngineError &&
              (error.stage === "panel" || error.stage === "setup")
            ? "panel"
            : "judge";
    }
  }
  return finish(input, dependencies.github, state, privacy, diff, historyAvailability);
}

export async function runReviewPipeline(
  input: ReviewInput,
  prepare: PrepareDependencies,
  execute: ExecuteDependencies,
): Promise<ReviewPipelineResult> {
  const result = await prepareReview(input, prepare);
  return result.kind === "PREPARED" ? executeReview(input, execute) : result;
}
