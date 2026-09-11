import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function denied(candidate: string): Error {
  return new Error(`ACCESS_DENIED_OUTSIDE_REVIEW_ROOT: ${candidate}`);
}

export function assertLexicallyContained(root: string, candidate: string): string {
  if (root.includes("\0") || candidate.includes("\0")) throw denied(candidate);
  const absolute = resolve(root, candidate);
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw denied(candidate);
  return absolute;
}

export async function assertRealpathContained(root: string, candidate: string): Promise<string> {
  const absolute = assertLexicallyContained(root, candidate);
  return assertLexicallyContained(await realpath(root), await realpath(absolute));
}

export async function assertCreatablePathContained(
  root: string,
  candidate: string,
): Promise<string> {
  const absolute = assertLexicallyContained(root, candidate);
  const canonicalRoot = await realpath(root);
  let ancestor = absolute;
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      )
        throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  // lstat identifies dangling links; never walk past a link whose target cannot be verified.
  let canonicalAncestor: string;
  try {
    canonicalAncestor = await realpath(ancestor);
  } catch {
    throw denied(candidate);
  }
  assertLexicallyContained(canonicalRoot, canonicalAncestor);
  return absolute;
}
