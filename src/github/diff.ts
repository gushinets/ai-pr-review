import { posix } from "node:path";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { isRepositoryRelativePath } from "../contracts/common.js";
import type { UnableReason } from "../contracts/failure-reasons.js";
import type { DiffIndex } from "../contracts/review-context.js";
import type { GithubReadClient } from "./github-client.js";

export class DiffError extends Error {
  constructor(
    readonly reason: Extract<UnableReason, "SNAPSHOT_FAILED" | "PR_TOO_LARGE"> = "SNAPSHOT_FAILED",
  ) {
    super(reason);
  }
}
export class StalePrDiffError extends Error {
  readonly status = "STALE_SKIPPED";
  constructor() {
    super("STALE_SKIPPED");
  }
}

function pathValue(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new DiffError();
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  const inner = value.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      const point = inner.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    } else {
      const octal = /^[0-3][0-7]{2}/.exec(inner.slice(i + 1));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 3;
      } else {
        const byte = escapes[inner[++i]!];
        if (byte === undefined) throw new DiffError();
        bytes.push(byte);
      }
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new DiffError();
  }
}
function repositoryPath(value: string): string {
  if (
    !isRepositoryRelativePath(value) ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
    )
  )
    throw new DiffError();
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.endsWith("/")) throw new DiffError();
  return normalized;
}
function prefixedPath(value: string, prefix: "a/" | "b/"): string {
  const decoded = pathValue(value);
  if (!decoded.startsWith(prefix)) throw new DiffError();
  return repositoryPath(decoded.slice(2));
}
interface ParsedFile {
  path: string;
  oldPath: string;
  additions: number;
  deletions: number;
  left: Set<number>;
  right: Set<number>;
}
function parseDiff(diff: string): { index: DiffIndex; files: Map<string, ParsedFile> } {
  const files = new Map<string, ParsedFile>();
  let file: ParsedFile | undefined;
  let oldHeader = false;
  let newHeader = false;
  let oldNull = false;
  let newNull = false;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  let hunk: { old: number; next: number; oldLeft: number; newLeft: number } | undefined;
  let bodySeen = false;
  let newlineMarker = false;
  let renameFrom = false;
  let renameTo = false;
  let metadataChange = false;
  const finishFile = () => {
    if (
      file &&
      (oldHeader !== newHeader ||
        (oldHeader && !bodySeen) ||
        renameFrom !== renameTo ||
        (!bodySeen && !metadataChange && !renameFrom))
    )
      throw new DiffError();
  };
  const finishHunk = () => {
    if (hunk && (hunk.oldLeft !== 0 || hunk.newLeft !== 0)) throw new DiffError();
    if (hunk) {
      previousOldEnd = hunk.old;
      previousNewEnd = hunk.next;
    }
    hunk = undefined;
  };
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line === "\\ No newline at end of file" && bodySeen) {
      if (newlineMarker) throw new DiffError();
      newlineMarker = true;
      continue;
    }
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      if (!file) throw new DiffError();
      const prefix = line[0];
      if (prefix !== " " && prefix !== "-" && prefix !== "+") throw new DiffError();
      if (prefix !== "+") {
        if (hunk.oldLeft-- <= 0) throw new DiffError();
        file.left.add(hunk.old++);
      }
      if (prefix !== "-") {
        if (hunk.newLeft-- <= 0) throw new DiffError();
        file.right.add(hunk.next++);
      }
      if (prefix === "+") file.additions++;
      if (prefix === "-") file.deletions++;
      bodySeen = true;
      newlineMarker = false;
      continue;
    }
    finishHunk();
    if (line.startsWith("diff --git ")) {
      finishFile();
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(line);
      if (!match) throw new DiffError();
      const oldPath = prefixedPath(match[1]!, "a/");
      const path = prefixedPath(match[2]!, "b/");
      if (files.has(path)) throw new DiffError();
      file = { path, oldPath, additions: 0, deletions: 0, left: new Set(), right: new Set() };
      files.set(path, file);
      oldHeader =
        newHeader =
        oldNull =
        newNull =
        bodySeen =
        newlineMarker =
        renameFrom =
        renameTo =
        metadataChange =
          false;
      previousOldEnd = previousNewEnd = 0;
    } else if (!file) {
      throw new DiffError();
    } else if (line.startsWith("@@")) {
      if (!oldHeader || !newHeader) throw new DiffError();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!match) throw new DiffError();
      const old = Number(match[1]);
      const oldLeft = Number(match[2] ?? 1);
      const next = Number(match[3]);
      const newLeft = Number(match[4] ?? 1);
      if (
        ![old, oldLeft, next, newLeft, old + oldLeft, next + newLeft].every(Number.isSafeInteger) ||
        (old === 0 && oldLeft !== 0) ||
        (next === 0 && newLeft !== 0) ||
        (oldLeft === 0 && newLeft === 0) ||
        old < previousOldEnd ||
        next < previousNewEnd ||
        (oldNull && oldLeft !== 0) ||
        (newNull && newLeft !== 0)
      )
        throw new DiffError();
      hunk = { old, next, oldLeft, newLeft };
      bodySeen = false;
    } else if (bodySeen) {
      throw new DiffError();
    } else if (line.startsWith("--- ")) {
      if (oldHeader || newHeader) throw new DiffError();
      oldHeader = true;
      oldNull = line.slice(4) === "/dev/null";
      if (!oldNull && prefixedPath(line.slice(4).replace(/\t$/, ""), "a/") !== file.oldPath)
        throw new DiffError();
    } else if (line.startsWith("+++ ")) {
      if (!oldHeader || newHeader) throw new DiffError();
      newHeader = true;
      newNull = line.slice(4) === "/dev/null";
      if (
        (oldNull && newNull) ||
        (!newNull && prefixedPath(line.slice(4).replace(/\t$/, ""), "b/") !== file.path)
      )
        throw new DiffError();
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      if (renameFrom) throw new DiffError();
      renameFrom = true;
      if (repositoryPath(pathValue(line.slice(line.indexOf("from ") + 5))) !== file.oldPath)
        throw new DiffError();
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      if (renameTo) throw new DiffError();
      renameTo = true;
      if (repositoryPath(pathValue(line.slice(line.indexOf("to ") + 3))) !== file.path)
        throw new DiffError();
    } else if (
      !/^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: \d{6})?|(?:old|new|deleted file|new file) mode \d{6}|(?:dis)?similarity index \d+%|Binary files .+ differ)$/.test(
        line,
      )
    ) {
      throw new DiffError();
    } else if (/^(?:(?:old|new|deleted file|new file) mode |Binary files )/.test(line)) {
      metadataChange = true;
    }
  }
  finishHunk();
  finishFile();
  return {
    files,
    index: {
      contains(location) {
        if (!Number.isSafeInteger(location.line) || location.line < 1) return false;
        const entry = files.get(location.path);
        return (
          (location.side === "LEFT"
            ? entry?.left
            : location.side === "RIGHT"
              ? entry?.right
              : undefined
          )?.has(location.line) ?? false
        );
      },
    },
  };
}

export function buildDiffIndex(unifiedDiff: string): DiffIndex {
  return parseDiff(unifiedDiff).index;
}

export async function loadPrDiff(
  github: GithubReadClient,
  repo: string,
  prNumber: number,
  expectedHeadSha: string,
): Promise<{ unifiedDiff: string; index: DiffIndex }> {
  try {
    const before = await github.getPullRequest(repo, prNumber);
    if (before.headSha !== expectedHeadSha) throw new StalePrDiffError();
    if (
      before.changedFiles > CENTRAL_CONFIG.maxChangedFiles ||
      before.additions + before.deletions > CENTRAL_CONFIG.maxChangedLines
    )
      throw new DiffError("PR_TOO_LARGE");
    const [unifiedDiff, metadata] = await Promise.all([
      github.getPullRequestDiff(repo, prNumber),
      github.listChangedFiles(repo, prNumber),
    ]);
    const after = await github.getPullRequest(repo, prNumber);
    if (after.headSha !== expectedHeadSha || after.baseSha !== before.baseSha)
      throw new StalePrDiffError();
    const { files, index } = parseDiff(unifiedDiff);
    const additions = metadata.reduce((sum, f) => sum + f.additions, 0);
    const deletions = metadata.reduce((sum, f) => sum + f.deletions, 0);
    if (
      files.size > CENTRAL_CONFIG.maxChangedFiles ||
      additions + deletions > CENTRAL_CONFIG.maxChangedLines
    )
      throw new DiffError("PR_TOO_LARGE");
    if (
      before.state !== "open" ||
      after.state !== "open" ||
      before.number !== prNumber ||
      after.number !== prNumber ||
      before.repository.toLowerCase() !== repo.toLowerCase() ||
      after.repository.toLowerCase() !== repo.toLowerCase() ||
      ![
        before.changedFiles,
        before.additions,
        before.deletions,
        after.changedFiles,
        after.additions,
        after.deletions,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      files.size !== metadata.length ||
      new Set(metadata.map((f) => repositoryPath(f.filename))).size !== metadata.length ||
      metadata.length !== before.changedFiles ||
      metadata.length !== after.changedFiles ||
      additions !== before.additions ||
      additions !== after.additions ||
      deletions !== before.deletions ||
      deletions !== after.deletions ||
      metadata.some((entry) => {
        const parsed = files.get(repositoryPath(entry.filename));
        return (
          !parsed ||
          ![entry.additions, entry.deletions].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          parsed.additions !== entry.additions ||
          parsed.deletions !== entry.deletions ||
          (entry.previous_filename !== undefined
            ? repositoryPath(entry.previous_filename) !== parsed.oldPath
            : parsed.oldPath !== parsed.path)
        );
      })
    )
      throw new DiffError();
    return { unifiedDiff, index };
  } catch (error) {
    if (error instanceof StalePrDiffError || error instanceof DiffError) throw error;
    throw new DiffError();
  }
}
