import { minimatch } from "minimatch";
import type { RepoConfigV1 } from "../contracts/repo-config.js";
import { isRepositoryRelativePath } from "../contracts/common.js";
import {
  ConfigError,
  validateRepoRelativePath,
  type ReadRepoContent,
} from "../config/repo-config.js";

export interface TrustedPolicyFile {
  path: string;
  content: string;
}

export class PolicyError extends Error {
  readonly reason = "POLICY_MISSING" as const;

  constructor(path: string) {
    super(`Selected policy is missing at the base SHA: ${path}`);
    this.name = "PolicyError";
  }
}

export async function selectTrustedPolicy(
  config: RepoConfigV1,
  changedPaths: readonly string[],
  baseSha: string,
  readContent: ReadRepoContent,
): Promise<TrustedPolicyFile[]> {
  for (const path of changedPaths) {
    if (!isRepositoryRelativePath(path)) {
      throw new ConfigError("CONFIG_INVALID", "Changed files contain an unsafe path");
    }
  }

  const selectedPaths = [...config.policy.always];
  for (const entry of config.policy.scoped) {
    for (const pattern of entry.paths) validateRepoRelativePath(pattern);
    if (
      changedPaths.some((path) =>
        entry.paths.some((pattern) => minimatch(path, pattern, { dot: true })),
      )
    ) {
      selectedPaths.push(...entry.include);
    }
  }

  const selected: TrustedPolicyFile[] = [];
  for (const path of new Set(selectedPaths)) {
    validateRepoRelativePath(path);
    const content = await readContent(path, baseSha);
    if (content === undefined) throw new PolicyError(path);
    selected.push({ path, content });
  }
  return selected;
}
