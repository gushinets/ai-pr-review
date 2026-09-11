import type { Octokit } from "@octokit/rest";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import type { ReviewStateV1 } from "../contracts/review-state.js";
import { retryRead } from "../github/github-client.js";
import { findingFingerprint } from "../publishing/findings.js";
import { calibrationMarker } from "../publishing/summary.js";
import { readCanonicalArtifact, trustedWorkflowPin } from "../state/github-artifact-store.js";
export interface CalibrationReportV1 {
  schema_version: 1;
  repository: string;
  completed_live_reviews: number;
  evaluated_blocking_cases: number;
  completed_review_rate: number;
  unable_rate: number;
  false_block_rate: number | null;
  blocking_finding_precision: number | null;
  material_miss_rate: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  median_cost_usd: number | null;
  p95_cost_usd: number | null;
  known_security_boundary_violations: number;
  stage2_criteria_met: boolean;
}

export interface CalibrationSample {
  outcome:
    "PASS" | "BLOCK" | "UNABLE_TO_REVIEW" | "MISSING_ATTEMPT" | "STALE_SKIPPED" | "NOT_ATTEMPTED";
  verdict: boolean | null;
  blockingFindings: Array<boolean | null>;
  materialMiss: boolean;
  latencyMs: number | null;
  costUsd: number | null;
}

export function buildCalibrationReport(
  repository: string,
  samples: CalibrationSample[],
  knownViolations: number,
): CalibrationReportV1 {
  const attempted = samples.filter(
    (s) => s.outcome !== "STALE_SKIPPED" && s.outcome !== "NOT_ATTEMPTED",
  );
  const completed = attempted.filter((s) => s.outcome === "PASS" || s.outcome === "BLOCK");
  const blocks = completed.filter((s) => s.outcome === "BLOCK" && s.verdict !== null);
  const findings = completed.flatMap((s) => s.blockingFindings).filter((v) => v !== null);
  const passes = completed.filter(
    (s) => s.outcome === "PASS" && (s.verdict !== null || s.materialMiss),
  );
  const ratio = (count: number, total: number) => (total ? count / total : null);
  const distribution = (values: Array<number | null>) => {
    if (!values.length || values.some((v) => v === null)) return [null, null] as const;
    const sorted = ([...values] as number[]).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return [
      sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
      sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    ] as const;
  };
  const [p50_latency_ms, p95_latency_ms] = distribution(completed.map((s) => s.latencyMs));
  const [median_cost_usd, p95_cost_usd] = distribution(attempted.map((s) => s.costUsd));
  const report: CalibrationReportV1 = {
    schema_version: 1,
    repository,
    completed_live_reviews: completed.length,
    evaluated_blocking_cases: blocks.length,
    completed_review_rate: ratio(completed.length, attempted.length) ?? 0,
    unable_rate: ratio(attempted.length - completed.length, attempted.length) ?? 0,
    false_block_rate: ratio(blocks.filter((s) => s.verdict === false).length, blocks.length),
    blocking_finding_precision: ratio(findings.filter(Boolean).length, findings.length),
    material_miss_rate: ratio(passes.filter((s) => s.materialMiss).length, passes.length),
    p50_latency_ms,
    p95_latency_ms,
    median_cost_usd,
    p95_cost_usd,
    known_security_boundary_violations: knownViolations,
    stage2_criteria_met: false,
  };
  report.stage2_criteria_met = calibrationCriteria(report).every((c) => c.pass);
  return report;
}

export function calibrationCriteria(
  r: CalibrationReportV1,
): Array<{ name: string; value: number | null; threshold: string; pass: boolean }> {
  return [
    {
      name: "Completed live reviews",
      value: r.completed_live_reviews,
      threshold: ">= 25",
      pass: r.completed_live_reviews >= 25,
    },
    {
      name: "Evaluated blocking cases",
      value: r.evaluated_blocking_cases,
      threshold: ">= 10",
      pass: r.evaluated_blocking_cases >= 10,
    },
    {
      name: "False-block rate",
      value: r.false_block_rate,
      threshold: "<= 0.05",
      pass: r.false_block_rate !== null && r.false_block_rate <= 0.05,
    },
    {
      name: "Blocking-finding precision",
      value: r.blocking_finding_precision,
      threshold: ">= 0.90",
      pass: r.blocking_finding_precision !== null && r.blocking_finding_precision >= 0.9,
    },
    {
      name: "Material-miss rate",
      value: r.material_miss_rate,
      threshold: "<= 0.10",
      pass: r.material_miss_rate !== null && r.material_miss_rate <= 0.1,
    },
    {
      name: "Completed-review rate",
      value: r.completed_review_rate,
      threshold: ">= 0.95",
      pass: r.completed_review_rate >= 0.95,
    },
    {
      name: "Unable rate",
      value: r.unable_rate,
      threshold: "<= 0.05",
      pass: r.unable_rate <= 0.05,
    },
    {
      name: "p95 latency ms after primary CI",
      value: r.p95_latency_ms,
      threshold: "<= 900000",
      pass: r.p95_latency_ms !== null && r.p95_latency_ms <= 900000,
    },
    {
      name: "Known security boundary violations",
      value: r.known_security_boundary_violations,
      threshold: "= 0",
      pass: r.known_security_boundary_violations === 0,
    },
  ];
}

export interface CalibrationCoverage {
  window_start: string;
  window_end: string;
  trusted_terminal_attempts: number;
  canonical_attempts: number;
  reused_artifacts: number;
  missing_attempts: number;
  excluded_runs: number;
  pending_runs: number;
  latency_observations: number;
  cost_observations: number;
}
export interface CalibrationResult {
  report: CalibrationReportV1;
  coverage: CalibrationCoverage;
}

// Paginate every read with retry per page; changing/incomplete evidence fails closed.
async function pages<T>(
  read: (page: number) => Promise<{ items: T[]; total?: number }>,
): Promise<T[]> {
  const items: T[] = [];
  let previousTotal: number | undefined;
  for (let page = 1; ; page++) {
    const result = await retryRead(() => read(page));
    items.push(...result.items);
    if (result.total !== undefined) {
      if (
        !Number.isSafeInteger(result.total) ||
        result.total < items.length ||
        (previousTotal !== undefined && previousTotal !== result.total) ||
        (items.length < result.total && result.items.length < 100)
      )
        throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
      previousTotal = result.total;
      if (items.length === result.total) return items;
    } else if (result.items.length < 100) return items;
  }
}
const botOwned = (user: { id: number; login: string; type: string } | null) =>
  user?.id === 41898282 && user.login === "github-actions[bot]" && user.type === "Bot";
const timestamp = (value: string | null | undefined) => (value ? Date.parse(value) : NaN);

export async function collectCalibration(
  octokit: Octokit,
  repository: string,
  knownViolations: number,
  now = new Date(),
): Promise<CalibrationResult> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(knownViolations) ||
    knownViolations < 0
  )
    throw new Error("CALIBRATION_INPUT_INVALID");
  const windowEnd = now.getTime();
  const windowStart = windowEnd - CENTRAL_CONFIG.artifactRetentionDays * 86400000;
  if (!Number.isFinite(windowEnd)) throw new Error("CALIBRATION_INPUT_INVALID");
  const [owner, repo] = repository.split("/") as [string, string];
  const params = { owner, repo };
  const { data: metadata } = await retryRead(() => octokit.rest.repos.get(params));
  if (metadata.full_name !== repository || !metadata.default_branch)
    throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
  const runs = await pages(async (page) => {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      ...params,
      workflow_id: "ai-pr-review.yml",
      per_page: 100,
      page,
    });
    return { items: data.workflow_runs, total: data.total_count };
  });
  const coverage: CalibrationCoverage = {
    window_start: new Date(windowStart).toISOString(),
    window_end: now.toISOString(),
    trusted_terminal_attempts: 0,
    canonical_attempts: 0,
    reused_artifacts: 0,
    missing_attempts: 0,
    excluded_runs: 0,
    pending_runs: 0,
    latency_observations: 0,
    cost_observations: 0,
  };
  const samples: CalibrationSample[] = [];
  const seen = new Map<
    string,
    { serialized: string; state: ReviewStateV1; publication: number | null }
  >();
  const permissions = new Map<string, boolean>();
  const authorized = async (user: { login: string; type: string } | null) => {
    if (!user || user.type !== "User") return false;
    if (!permissions.has(user.login)) {
      try {
        const { data } = await retryRead(() =>
          octokit.rest.repos.getCollaboratorPermissionLevel({ ...params, username: user.login }),
        );
        permissions.set(user.login, ["write", "maintain", "admin"].includes(data.permission));
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("status" in error) ||
          error.status !== 404
        )
          throw error;
        permissions.set(user.login, false);
      }
    }
    return permissions.get(user.login)!;
  };
  const reactions = async (commentId: number, inline: boolean, after: number) => {
    const values = await pages(async (page) => {
      const { data } = inline
        ? await octokit.rest.reactions.listForPullRequestReviewComment({
            ...params,
            comment_id: commentId,
            per_page: 100,
            page,
          })
        : await octokit.rest.reactions.listForIssueComment({
            ...params,
            comment_id: commentId,
            per_page: 100,
            page,
          });
      return { items: data };
    });
    const labels = new Set<boolean>();
    for (const reaction of values) {
      if (
        (reaction.content === "+1" || reaction.content === "-1") &&
        timestamp(reaction.created_at) > after &&
        (await authorized(reaction.user))
      )
        labels.add(reaction.content === "+1");
    }
    return labels.size === 1 ? [...labels][0]! : null;
  };
  const observe = async (
    state: ReviewStateV1,
    publication: number | null,
  ): Promise<CalibrationSample> => {
    const head = state.attempt_identity.head_sha;
    const pr = state.attempt_identity.pr_number;
    const start = timestamp(state.telemetry.started_at);
    const finish = timestamp(state.telemetry.finished_at);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start)
      throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
    const sample: CalibrationSample = {
      outcome: state.outcome,
      verdict: null,
      blockingFindings: [],
      materialMiss: false,
      latencyMs: null,
      costUsd: state.telemetry.estimated_cost_usd,
    };
    if (state.outcome === "UNABLE_TO_REVIEW") return sample;
    const { data: pull } = await retryRead(() =>
      octokit.rest.pulls.get({ ...params, pull_number: pr }),
    );
    const summaries = await pages(async (page) => ({
      items: (
        await octokit.rest.issues.listComments({ ...params, issue_number: pr, per_page: 100, page })
      ).data,
    }));
    const matching = summaries.filter(
      (comment) =>
        botOwned(comment.user) &&
        comment.body?.startsWith(
          `${CENTRAL_CONFIG.summaryMarker}\n${calibrationMarker(state)}\n`,
        ) &&
        pull.head.sha === head,
    );
    if (matching.length === 1) {
      const summary = matching[0]!;
      sample.verdict = await reactions(
        summary.id,
        false,
        Math.max(finish, timestamp(summary.updated_at)),
      );
      const { data: current } = await retryRead(() =>
        octokit.rest.issues.getComment({ ...params, comment_id: summary.id }),
      );
      if (
        current.body !== summary.body ||
        current.updated_at !== summary.updated_at ||
        !botOwned(current.user)
      )
        throw new Error("CALIBRATION_EVIDENCE_CHANGED");
    }
    const comments = await pages(async (page) => ({
      items: (
        await octokit.rest.pulls.listReviewComments({
          ...params,
          pull_number: pr,
          per_page: 100,
          page,
        })
      ).data,
    }));
    for (const finding of state.findings.filter(
      (f) => f.severity === "blocking" && f.confidence === "high",
    )) {
      const marker = `\n\n<!-- ${CENTRAL_CONFIG.findingMarkerPrefix}:${findingFingerprint(head, finding)} -->`;
      const matching = comments.filter(
        (comment) =>
          botOwned(comment.user) &&
          comment.original_commit_id === head &&
          comment.body.endsWith(marker),
      );
      sample.blockingFindings.push(
        matching.length === 1
          ? await reactions(
              matching[0]!.id,
              true,
              Math.max(finish, timestamp(matching[0]!.updated_at)),
            )
          : null,
      );
    }
    const timeline = await pages(async (page) => ({
      items: (
        await octokit.rest.issues.listEventsForTimeline({
          ...params,
          issue_number: pr,
          per_page: 100,
          page,
        })
      ).data,
    }));
    if (state.outcome === "PASS")
      for (const event of timeline) {
        if (
          event.event === "commented" &&
          "body" in event &&
          typeof event.body === "string" &&
          event.body.includes(`<!-- ai-pr-review-material-miss:v1:${head} -->`) &&
          "created_at" in event &&
          timestamp(event.created_at) > finish &&
          "user" in event &&
          (await authorized(event.user))
        )
          sample.materialMiss = true;
      }
    const ci = await pages(async (page) => {
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        ...params,
        head_sha: head,
        per_page: 100,
        page,
      });
      return { items: data.workflow_runs, total: data.total_count };
    });
    const completions: number[] = [];
    for (const run of ci.filter(
      (run) =>
        run.repository.full_name === repository &&
        run.head_sha === head &&
        run.event === "pull_request" &&
        run.name === state.ci_summary?.primary_ci_workflow &&
        run.status === "completed" &&
        run.pull_requests?.some((item) => item.number === pr),
    )) {
      const jobs = await pages(async (page) => {
        const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
          ...params,
          run_id: run.id,
          filter: "latest",
          per_page: 100,
          page,
        });
        return { items: data.jobs, total: data.total_count };
      });
      if (
        jobs.length &&
        jobs.every(
          (job) =>
            job.run_id === run.id &&
            job.status === "completed" &&
            Number.isFinite(timestamp(job.completed_at)),
        )
      ) {
        const completed = Math.max(...jobs.map((job) => timestamp(job.completed_at)));
        if (completed <= start) completions.push(completed);
      }
    }
    if (completions.length && publication !== null)
      sample.latencyMs = publication - Math.max(...completions);
    const { data: current } = await retryRead(() =>
      octokit.rest.pulls.get({ ...params, pull_number: pr }),
    );
    if (current.head.sha !== pull.head.sha) throw new Error("CALIBRATION_EVIDENCE_CHANGED");
    return sample;
  };
  for (const listed of runs) {
    const { data: latest } = await retryRead(() =>
      octokit.rest.actions.getWorkflowRun({ ...params, run_id: listed.id }),
    );
    if (latest.id !== listed.id) throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
    if (trustedWorkflowPin(latest, repository, metadata.default_branch) === null) continue;
    const count = latest.run_attempt;
    if (!count || !Number.isSafeInteger(count) || count < 1)
      throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
    const attempts = [];
    for (let n = 1; n <= count; n++) {
      const { data } = await retryRead(() =>
        octokit.rest.actions.getWorkflowRunAttempt({
          ...params,
          run_id: listed.id,
          attempt_number: n,
        }),
      );
      if (
        data.id !== listed.id ||
        data.run_attempt !== n ||
        !Number.isFinite(timestamp(data.run_started_at))
      )
        throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
      attempts.push(data);
    }
    const artifacts = await pages(async (page) => {
      const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
        ...params,
        run_id: listed.id,
        per_page: 100,
        page,
      });
      return { items: data.artifacts, total: data.total_count };
    });
    for (const [index, attempt] of attempts.entries()) {
      if (
        timestamp(attempt.run_started_at) < windowStart ||
        timestamp(attempt.run_started_at) > windowEnd
      )
        continue;
      const pin = trustedWorkflowPin(attempt, repository, metadata.default_branch);
      if (pin === null) continue;
      if (attempt.status !== "completed") {
        coverage.pending_runs++;
        continue;
      }
      coverage.trusted_terminal_attempts++;
      const jobs = await pages(async (page) => {
        const { data } = await octokit.rest.actions.listJobsForWorkflowRunAttempt({
          ...params,
          run_id: listed.id,
          attempt_number: attempt.run_attempt!,
          per_page: 100,
          page,
        });
        return { items: data.jobs, total: data.total_count };
      });
      if (jobs.some((job) => job.run_id !== listed.id))
        throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
      const publishers = jobs.filter(
        (job) => job.name === "publisher" || job.name.endsWith(" / publisher"),
      );
      const publisher = publishers.length === 1 ? publishers[0] : undefined;
      const published =
        publisher?.status === "completed" && publisher.conclusion === "success"
          ? timestamp(publisher.completed_at)
          : NaN;
      let found = false;
      for (const artifact of artifacts.filter((a) =>
        /^ai-review-state-v1-pr-[1-9][0-9]*$/.test(a.name),
      )) {
        const created = timestamp(artifact.created_at);
        if (!Number.isFinite(created)) throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
        if (
          created < timestamp(attempt.run_started_at) ||
          created >= timestamp(attempts[index + 1]?.run_started_at)
        )
          continue;
        if (artifact.expired) continue;
        const state = await readCanonicalArtifact(octokit, repository, artifact.id, pin);
        if (state === null) continue;
        if (
          state.attempt_identity.repository !== repository ||
          artifact.name !== `ai-review-state-v1-pr-${state.attempt_identity.pr_number}`
        )
          throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
        found = true;
        const started = timestamp(state.telemetry.started_at);
        const finished = timestamp(state.telemetry.finished_at);
        if (
          !Number.isFinite(started) ||
          !Number.isFinite(finished) ||
          finished < started ||
          finished > created
        )
          throw new Error("CALIBRATION_EVIDENCE_INCOMPLETE");
        if (started < windowStart) {
          coverage.reused_artifacts++;
          continue;
        }
        const publication =
          Number.isFinite(published) && published >= finished && published <= windowEnd
            ? published
            : null;
        const key = calibrationMarker(state);
        const serialized = JSON.stringify(state);
        if (seen.has(key)) {
          const previous = seen.get(key)!;
          if (previous.serialized !== serialized) throw new Error("CALIBRATION_EVIDENCE_CHANGED");
          if (
            publication !== null &&
            (previous.publication === null || publication < previous.publication)
          )
            previous.publication = publication;
          coverage.reused_artifacts++;
          continue;
        }
        seen.set(key, { serialized, state, publication });
        coverage.canonical_attempts++;
      }
      if (found) continue;

      const reviewJobs = jobs.filter((j) => j.name === "review" || j.name.endsWith(" / review"));
      const preflights = jobs.filter(
        (j) => j.name === "preflight" || j.name.endsWith(" / preflight"),
      );
      const review = reviewJobs.length === 1 ? reviewJobs[0] : undefined;
      const classify = review?.steps?.find(
        (s) => s.name === "Classify canonical state" && s.conclusion === "success",
      );
      const stale =
        review?.conclusion === "success" &&
        classify &&
        review.steps?.some(
          (s) =>
            s.number === classify.number + 1 &&
            /^Run actions\/upload-artifact@[0-9a-f]{40}$/.test(s.name) &&
            s.conclusion === "skipped",
        );
      if (
        stale ||
        (review?.conclusion === "skipped" &&
          preflights.length === 1 &&
          preflights[0]!.conclusion === "success")
      ) {
        coverage.excluded_runs++;
      } else {
        coverage.missing_attempts++;
        samples.push({
          outcome: "MISSING_ATTEMPT",
          verdict: null,
          blockingFindings: [],
          materialMiss: false,
          latencyMs: null,
          costUsd: null,
        });
      }
    }
  }
  for (const { state, publication } of seen.values())
    samples.push(await observe(state, publication));
  coverage.latency_observations = samples.filter((s) => s.latencyMs !== null).length;
  coverage.cost_observations = samples.filter((s) => s.costUsd !== null).length;
  return { report: buildCalibrationReport(repository, samples, knownViolations), coverage };
}
