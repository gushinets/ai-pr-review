import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Octokit } from "@octokit/rest";
import { mintInstallationToken } from "./github-app.js";
import { SqliteCommandLedger } from "./command-ledger.js";
import { readGatewayConfig } from "./server.js";

type Run = { id: number; status: string | null; conclusion: string | null };
type RunReader = { runs: () => Promise<Run[]>; jobs: (id: number) => Promise<unknown[]> };
type Inspection = {
  status:
    | "NOT_CLAIMED"
    | "COMPLETED"
    | "ACTIVE"
    | "NO_MATCHING_RUN"
    | "AMBIGUOUS"
    | "EXECUTED_OR_UNKNOWN"
    | "PROVEN_NOT_EXECUTED";
  runIds: number[];
};
const active = new Set(["queued", "pending", "waiting", "requested", "in_progress"]);

export async function inspectCommand(
  ledger: SqliteCommandLedger,
  delivery: string,
  reader: RunReader,
): Promise<Inspection> {
  const local = ledger.commandStatus(delivery);
  if (local === null) return { status: "NOT_CLAIMED", runIds: [] };
  if (local === "completed") return { status: "COMPLETED", runIds: [] };
  try {
    const runs = await reader.runs();
    const runIds = runs.map((run) => run.id);
    if (!runs.length) return { status: "NO_MATCHING_RUN", runIds };
    if (runs.some((run) => active.has(run.status ?? ""))) return { status: "ACTIVE", runIds };
    if (runs.some((run) => run.status !== "completed")) return { status: "AMBIGUOUS", runIds };
    for (const run of runs) {
      if (run.conclusion !== "cancelled" || (await reader.jobs(run.id)).length !== 0)
        return { status: "EXECUTED_OR_UNKNOWN", runIds };
    }
    return { status: "PROVEN_NOT_EXECUTED", runIds };
  } catch {
    return { status: "AMBIGUOUS", runIds: [] };
  }
}

/** Operator only: quiesce the gateway and prohibit dispatch/reruns during repair.
 * GitHub run reads and the local ledger cannot share an atomic transaction.
 * Absence, timeouts, any started job, or completed verdicts never authorize release.
 */
export async function releaseUnstartedCommand(
  ledger: SqliteCommandLedger,
  delivery: string,
  reader: RunReader,
): Promise<"RELEASED"> {
  const first = await inspectCommand(ledger, delivery, reader);
  const second = await inspectCommand(ledger, delivery, reader);
  if (
    first.status !== "PROVEN_NOT_EXECUTED" ||
    second.status !== "PROVEN_NOT_EXECUTED" ||
    JSON.stringify(first.runIds) !== JSON.stringify(second.runIds)
  )
    throw new Error("RECONCILIATION_NOT_PROVEN");
  ledger.reconcile(delivery, "proven_not_dispatched");
  return "RELEASED";
}

async function runReader(env: NodeJS.ProcessEnv, delivery: string): Promise<RunReader> {
  const config = readGatewayConfig(env);
  const token = await mintInstallationToken(
    config.central.credentials,
    undefined,
    config.central.repository,
    "inspect",
  );
  const github = new Octokit({
    auth: token,
    request: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const [owner, repo] = config.central.repository.split("/") as [string, string];
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  const branch = repository.default_branch;
  if (config.central.ref !== branch) throw new Error("RECONCILIATION_NOT_PROVEN");
  return {
    async runs() {
      const matches: Run[] = [];
      // ponytail: inspect at most 1,000 retained runs; retain dispatch run IDs if history grows beyond this ceiling.
      for (let page = 1; page <= 10; page++) {
        const { data } = await github.rest.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: config.central.workflow,
          branch,
          event: "workflow_dispatch",
          per_page: 100,
          page,
        });
        if (
          !Number.isSafeInteger(data.total_count) ||
          data.total_count > 1000 ||
          data.total_count < 0
        )
          throw new Error("RECONCILIATION_NOT_PROVEN");
        for (const run of data.workflow_runs) {
          if (run.display_title !== `AI PR Review V2 canonical ${delivery}`) continue;
          if (
            run.repository.full_name.toLowerCase() !== config.central.repository.toLowerCase() ||
            run.path !== `.github/workflows/${config.central.workflow}` ||
            run.head_branch !== branch ||
            run.event !== "workflow_dispatch" ||
            !Number.isSafeInteger(run.id) ||
            run.id < 1
          )
            throw new Error("RECONCILIATION_NOT_PROVEN");
          matches.push({ id: run.id, status: run.status, conclusion: run.conclusion });
        }
        if (page * 100 >= data.total_count) return matches.sort((a, b) => a.id - b.id);
        if (data.workflow_runs.length !== 100) throw new Error("RECONCILIATION_NOT_PROVEN");
      }
      throw new Error("RECONCILIATION_NOT_PROVEN");
    },
    async jobs(run_id) {
      // Any job from any rerun attempt keeps the claim held, even failed setup.
      const { data } = await github.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id,
        filter: "all",
        per_page: 1,
      });
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0)
        throw new Error("RECONCILIATION_NOT_PROVEN");
      return data.total_count === 0 && data.jobs.length === 0 ? [] : [true];
    },
  };
}

export async function runReconciliationCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let ledger: SqliteCommandLedger | undefined;
  try {
    const [mode, delivery] = args;
    if (
      args.length !== 2 ||
      !["inspect", "release"].includes(mode ?? "") ||
      !/^[A-Za-z0-9-]{1,100}$/.test(delivery ?? "") ||
      (mode === "release" && env.AI_REVIEW_RECONCILIATION_FROZEN !== "true")
    )
      return 70;
    const config = readGatewayConfig(env);
    const file = lstatSync(config.ledgerPath);
    if (!file.isFile() || file.isSymbolicLink()) return 70;
    ledger = new SqliteCommandLedger(config.ledgerPath);
    const reader = await runReader(env, delivery!);
    const result =
      mode === "release"
        ? { status: await releaseUnstartedCommand(ledger, delivery!, reader) }
        : await inspectCommand(ledger, delivery!, reader);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    process.stderr.write("RECONCILIATION_NOT_PROVEN\n");
    return 70;
  } finally {
    ledger?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runReconciliationCli(process.argv.slice(2));
