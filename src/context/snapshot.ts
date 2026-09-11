import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { isRepositoryRelativePath } from "../contracts/common.js";
import { validateReviewContext, type ReviewContextV1 } from "../contracts/review-context.js";
import { extractSafeArchive } from "../github/archive.js";
import { unifiedDiffSections } from "../github/diff.js";
import type { ChangedFile } from "../github/preflight-reader.js";
import type { LinearRequirementsContextV1 } from "../linear/requirements-loader.js";
import { installGitDiffShim } from "../sandbox/git-diff-shim.js";
import {
  assertCreatablePathContained,
  assertRealpathContained,
} from "../sandbox/path-containment.js";
import type { TrustedPolicyFile } from "./trusted-policy.js";

export interface SnapshotInput {
  privateDir: string;
  headArchive: { headSha: string; stream: Readable };
  context: ReviewContextV1;
  policy: readonly TrustedPolicyFile[];
  requirements: LinearRequirementsContextV1;
  unifiedDiff: string;
  changedFiles: readonly ChangedFile[];
  ciSourceRoot: string;
}
export async function buildReviewSnapshot(
  input: SnapshotInput,
): Promise<{ reviewRoot: string; runtimeDir: string; gitShim: string; context: ReviewContextV1 }> {
  const reject = () => new Error("SNAPSHOT_FAILED");
  const safe = (path: string) => {
    if (
      !isRepositoryRelativePath(path) ||
      path.split("/").some((part) => !part || part === ".") ||
      // eslint-disable-next-line no-control-regex -- reject C0/C1 characters in materialized paths.
      /[\x00-\x1f\x7f-\x9f]/.test(path)
    )
      throw reject();
    return path;
  };
  if (
    !validateReviewContext(input.context).ok ||
    input.headArchive.headSha !== input.context.review_identity.head_sha ||
    input.requirements.identifier !== input.context.review_identity.linear_issue
  )
    throw reject();
  const sections = new Set(unifiedDiffSections(input.unifiedDiff).map((section) => section.path));
  if (
    sections.size !== input.changedFiles.length ||
    new Set(input.changedFiles.map((file) => file.filename)).size !== input.changedFiles.length ||
    input.changedFiles.some((file) => {
      safe(file.filename);
      return (
        !sections.has(file.filename) ||
        ![file.additions, file.deletions].every((n) => Number.isSafeInteger(n) && n >= 0)
      );
    })
  )
    throw reject();
  for (const policy of input.policy) safe(policy.path);
  const context = structuredClone(input.context);
  context.policy_paths = input.policy.map((file) => "control/policy/" + file.path).sort();
  const logs = context.ci.checks.flatMap((check) => {
    if (check.failed_log_path === null) return [];
    const match = /^(?:ci-logs|evidence\/ci)\/([1-9][0-9]*-[1-9][0-9]*\.log)$/.exec(
      check.failed_log_path,
    );
    if (!match) throw reject();
    const source = "ci-logs/" + match[1];
    check.failed_log_path = "evidence/ci/" + match[1];
    return [{ source, path: check.failed_log_path }];
  });
  const privateDir = resolve(input.privateDir);
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const reviewRoot = join(privateDir, "review-root");
  const runtimeDir = join(privateDir, "runtime");
  // Fresh roots only: never merge trusted resources with remnants of an earlier snapshot.
  await mkdir(reviewRoot, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  const write = async (path: string, data: string) => {
    const dest = await assertCreatablePathContained(reviewRoot, join(reviewRoot, safe(path)));
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await assertRealpathContained(reviewRoot, dirname(dest));
    await writeFile(dest, data, { flag: "wx", mode: 0o600 });
  };
  await extractSafeArchive(input.headArchive.stream, join(reviewRoot, "target"));
  for (const file of input.policy) await write("control/policy/" + file.path, file.content);
  await write(
    ".rejudge/config.json",
    JSON.stringify({
      reviewers: CENTRAL_CONFIG.reviewers.map((m) => `${m.model}@${m.level}`),
      judge: `${CENTRAL_CONFIG.judge.model}@${CENTRAL_CONFIG.judge.level}`,
      debugLog: false,
    }),
  );
  await write("requirements/linear.json", JSON.stringify(input.requirements));
  for (const log of new Map(logs.map((log) => [log.path, log])).values()) {
    const source = await assertRealpathContained(
      input.ciSourceRoot,
      join(input.ciSourceRoot, log.source),
    );
    await write(log.path, await readFile(source, "utf8"));
  }
  await write("evidence/ci/status.json", JSON.stringify(context.ci));
  await write("diff/pr.diff", input.unifiedDiff);
  await write(
    "diff/numstat.txt",
    input.changedFiles
      .map((file) => `${file.additions}\t${file.deletions}\t${file.filename}\n`)
      .join(""),
  );
  await write("metadata/review-context.json", JSON.stringify(context));
  for (const dir of ["pi-agent", "home", "xdg", "tmp"])
    await mkdir(join(runtimeDir, dir), { mode: 0o700 });
  const gitShim = await installGitDiffShim(reviewRoot, runtimeDir);
  return { reviewRoot, runtimeDir, gitShim, context };
}
