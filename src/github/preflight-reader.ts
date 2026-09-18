export interface PullRequest {
  number: number;
  state: string;
  repository: string;
  author: string;
  title: string;
  body: string | null;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}
export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
}
export interface WorkflowRun {
  event: string;
  name: string | null;
  headSha: string;
  pullRequests: number[];
}
export interface AssociatedPullRequest {
  number: number;
  state: string;
  repository: string;
}
export interface GitHubReader {
  getWorkflowRun(repository: string, runId: number): Promise<WorkflowRun>;
  getPullRequest(repository: string, prNumber: number): Promise<PullRequest>;
  associatedPullRequests(repository: string, headSha: string): Promise<AssociatedPullRequest[]>;
  getPermission(repository: string, actor: string): Promise<string>;
  readContent(repository: string, path: string, sha: string): Promise<string | undefined>;
  listChangedFiles(repository: string, prNumber: number): Promise<ChangedFile[]>;
}
export type PreflightTrigger =
  | { mode: "automatic"; repository: string; triggeringRunId: number }
  | {
      mode: "manual";
      repository: string;
      prNumber: number;
      actor: string;
      expectedHeadSha?: string;
    };
export type Resolution =
  | { status: "RESOLVED"; pr: PullRequest; workflowName: string | null }
  | { status: "NOT_APPLICABLE_SKIPPED" | "STALE_SKIPPED" };

export async function resolvePullRequest(
  input: PreflightTrigger,
  reader: GitHubReader,
): Promise<Resolution> {
  let prNumber: number;
  let run: WorkflowRun | undefined;
  if (input.mode === "automatic") {
    run = await reader.getWorkflowRun(input.repository, input.triggeringRunId);
    if (run.event !== "pull_request") return { status: "NOT_APPLICABLE_SKIPPED" };
    let numbers = run.pullRequests;
    if (numbers.length === 0) {
      numbers = (await reader.associatedPullRequests(input.repository, run.headSha))
        .filter(
          (pr) =>
            pr.state === "open" && pr.repository.toLowerCase() === input.repository.toLowerCase(),
        )
        .map((pr) => pr.number);
    }
    if (numbers.length !== 1) return { status: "NOT_APPLICABLE_SKIPPED" };
    prNumber = numbers[0]!;
  } else {
    prNumber = input.prNumber;
  }
  const pr = await reader.getPullRequest(input.repository, prNumber);
  if (
    pr.state !== "open" ||
    pr.repository.toLowerCase() !== input.repository.toLowerCase() ||
    pr.number !== prNumber
  )
    return { status: "NOT_APPLICABLE_SKIPPED" };
  if (
    (run && run.headSha !== pr.headSha) ||
    (input.mode === "manual" && input.expectedHeadSha && input.expectedHeadSha !== pr.headSha)
  )
    return { status: "STALE_SKIPPED" };
  return { status: "RESOLVED", pr, workflowName: run?.name ?? null };
}
