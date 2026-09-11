import { mkdir, writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import Schema from "typebox/schema";
import type { UnableReason } from "../contracts/failure-reasons.js";
import {
  CiContextV1Schema,
  type CiCheckV1,
  type CiContextV1,
} from "../contracts/review-context.js";
import { assertCreatablePathContained } from "../sandbox/path-containment.js";
import type { GithubReadClient, GitHubWorkflowJob } from "./github-client.js";

export class CiContextError extends Error {
  readonly reason: Extract<UnableReason, "CI_CONTEXT_UNAVAILABLE"> = "CI_CONTEXT_UNAVAILABLE";
  constructor() {
    super("CI_CONTEXT_UNAVAILABLE");
  }
}

export function sanitizeCiLog(raw: string, knownSecrets: readonly string[]): string {
  const redactKnown = (text: string) => {
    for (const secret of [...knownSecrets].filter(Boolean).sort((a, b) => b.length - a.length))
      text = text.split(secret).join("[REDACTED]");
    return text;
  };
  let text = redactKnown(raw);
  text = stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- explicitly remove C0/C1 log controls except LF and TAB.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  text = redactKnown(text)
    .replace(/\bauthorization[ \t]*[:=][^\n]*/gi, "Authorization: [REDACTED]")
    .replace(/\bbearer[ \t]+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:[a-z0-9_]*(?:TOKEN|SECRET|PASSWORD)|[a-z0-9_]*API_KEY)[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      (value) => `${value.slice(0, value.search(/[:=]/) + 1)}[REDACTED]`,
    );
  // Environment dumps are unnecessary evidence; keep keys, never assignment values.
  let envIndent: number | undefined;
  text = text
    .split("\n")
    .map((line) => {
      const prefix = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?/.exec(line)![0];
      const content = line.slice(prefix.length);
      if (/^\s*env:\s*$/.test(content)) {
        envIndent = content.search(/\S/);
        return line;
      }
      if (envIndent !== undefined) {
        if (content.trim() && content.search(/\S/) > envIndent)
          return `${prefix}[REDACTED ENVIRONMENT]`;
        envIndent = undefined;
      }
      return (
        prefix + content.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=).*$/, "$1[REDACTED]")
      );
    })
    .join("\n");
  const limit = 512 * 1024;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const marker = "\n[TRUNCATED BY AI PR REVIEW]";
  let end = limit - Buffer.byteLength(marker);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

const validator = Schema.Compile(CiContextV1Schema);
const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function loadCiContext(
  github: GithubReadClient,
  repo: string,
  headSha: string,
  primaryCiWorkflow: string,
  privateWorkDir: string,
  knownSecrets: readonly string[] = [],
  warn: (warning: string) => void = () => {},
): Promise<CiContextV1> {
  const ci: CiContextV1 = {
    schema_version: 1,
    head_sha: headSha,
    primary_ci_workflow: primaryCiWorkflow,
    checks: [],
  };
  const checkIds = new Map<CiCheckV1, number>();
  try {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      !primaryCiWorkflow.trim() ||
      !validator.Check(ci)
    )
      throw new CiContextError();
    const [rawChecks, combined] = await Promise.all([
      github.listCheckRuns(repo, headSha),
      github.getCommitStatuses(repo, headSha),
    ]);
    if (combined.sha !== headSha) throw new CiContextError();
    const unique = new Map<string, { id: number; check: CiCheckV1 }>();
    const add = (key: string, id: number, check: CiCheckV1) => {
      if (!positiveId(id) || !validator.Check({ ...ci, checks: [check] }))
        throw new CiContextError();
      const prior = unique.get(key);
      if (
        !prior ||
        id > prior.id ||
        (id === prior.id && compare(JSON.stringify(check), JSON.stringify(prior.check)) < 0)
      )
        unique.set(key, { id, check });
    };
    for (const raw of rawChecks) {
      if (
        raw.headSha !== headSha ||
        (raw.appId !== null && !positiveId(raw.appId)) ||
        (raw.externalId !== null && typeof raw.externalId !== "string")
      )
        throw new CiContextError();
      const check = {
        kind: "check_run",
        name: raw.name,
        status: raw.status,
        conclusion: raw.conclusion,
        details_url: raw.detailsUrl,
        workflow_run_id: null,
        job_id: null,
        failed_log_path: null,
      } as CiCheckV1;
      add(
        JSON.stringify(["check_run", raw.name, raw.appId, raw.externalId || raw.id]),
        raw.id,
        check,
      );
      checkIds.set(check, raw.id);
    }
    for (const raw of combined.statuses) {
      if (!["pending", "success", "failure", "error"].includes(raw.state))
        throw new CiContextError();
      add(JSON.stringify(["commit_status", raw.context]), raw.id, {
        kind: "commit_status",
        name: raw.context,
        status: raw.state === "pending" ? "pending" : "completed",
        conclusion:
          raw.state === "pending" ? null : raw.state === "success" ? "success" : "failure",
        details_url: raw.targetUrl,
        workflow_run_id: null,
        job_id: null,
        failed_log_path: null,
      });
    }
    ci.checks = [...unique.values()].map(({ check }) => check);
  } catch {
    throw new CiContextError();
  }

  const jobs = new Map<number, GitHubWorkflowJob | null>();
  try {
    const runs = await github.listWorkflowRuns(repo, headSha);
    for (const run of runs) {
      if (!positiveId(run.id) || run.headSha !== headSha) continue;
      try {
        for (const job of await github.listWorkflowJobs(repo, run.id)) {
          if (!positiveId(job.id) || job.runId !== run.id || job.headSha !== headSha) continue;
          const prefix = `https://api.github.com/repos/${repo}/check-runs/`;
          if (!job.checkRunUrl.startsWith(prefix)) continue;
          const idText = job.checkRunUrl.slice(prefix.length);
          if (!/^[1-9]\d*$/.test(idText) || !positiveId(Number(idText))) continue;
          const id = Number(idText);
          const prior = jobs.get(id);
          // Ambiguous mappings supply no log rather than attributing another job's evidence.
          jobs.set(
            id,
            prior === null || (prior && (prior.id !== job.id || prior.runId !== job.runId))
              ? null
              : job,
          );
        }
      } catch {
        warn("CI_JOB_MAPPING_UNAVAILABLE");
      }
    }
  } catch {
    warn("CI_JOB_MAPPING_UNAVAILABLE");
  }
  for (const check of ci.checks) {
    const id = checkIds.get(check);
    const job = id === undefined ? undefined : jobs.get(id);
    if (job) {
      check.workflow_run_id = job.runId;
      check.job_id = job.id;
    }
  }
  ci.checks.sort(
    (a, b) =>
      compare(a.name, b.name) ||
      (a.workflow_run_id ?? -1) - (b.workflow_run_id ?? -1) ||
      (a.job_id ?? -1) - (b.job_id ?? -1) ||
      compare(JSON.stringify(a), JSON.stringify(b)),
  );
  for (const check of ci.checks) {
    if (
      check.job_id === null ||
      check.workflow_run_id === null ||
      check.status !== "completed" ||
      !["failure", "timed_out", "cancelled"].includes(check.conclusion ?? "")
    )
      continue;
    try {
      const raw = await github.downloadJobLog(repo, check.job_id);
      const directory = await assertCreatablePathContained(privateWorkDir, "ci-logs");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const relative = `ci-logs/${check.workflow_run_id}-${check.job_id}.log`;
      const path = await assertCreatablePathContained(privateWorkDir, relative);
      await writeFile(path, sanitizeCiLog(raw, knownSecrets), {
        encoding: "utf8",
        mode: 0o400,
        flag: "wx",
      });
      check.failed_log_path = relative;
    } catch {
      warn("CI_JOB_LOG_UNAVAILABLE");
    }
  }
  return ci;
}
