import { parse } from "yaml";
import type { RepoConfigV1 } from "../contracts/repo-config.js";
import { validateRepoConfig } from "../contracts/repo-config.js";
import { isRepositoryRelativePath } from "../contracts/common.js";

export type ReadRepoContent = (path: string, sha: string) => Promise<string | undefined>;

export class ConfigError extends Error {
  constructor(
    public readonly reason: "CONFIG_MISSING" | "CONFIG_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function validateRepoRelativePath(value: string): string {
  if (!isRepositoryRelativePath(value)) {
    throw new ConfigError("CONFIG_INVALID", "Repository config contains an unsafe path");
  }
  return value;
}

export function parseRepoConfig(source: string): RepoConfigV1 {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new ConfigError("CONFIG_INVALID", "Repository config is not valid YAML");
  }

  const result = validateRepoConfig(value);
  if (!result.ok) {
    throw new ConfigError("CONFIG_INVALID", result.errors.join("; "));
  }

  const { policy } = result.value;
  if (
    policy.scoped.some(({ paths, include }) => paths.length === 0 || include.length === 0) ||
    hasDuplicates(policy.always) ||
    policy.scoped.some(({ include }) => hasDuplicates(include))
  ) {
    throw new ConfigError(
      "CONFIG_INVALID",
      "Repository config contains empty or duplicate policy entries",
    );
  }

  for (const path of policy.always) validateRepoRelativePath(path);
  for (const entry of policy.scoped) {
    for (const pattern of entry.paths) validateRepoRelativePath(pattern);
    for (const path of entry.include) validateRepoRelativePath(path);
  }

  return result.value;
}

export async function loadRepoConfigAtBase(
  baseSha: string,
  readContent: ReadRepoContent,
): Promise<RepoConfigV1> {
  const source = await readContent(".github/ai-review.yml", baseSha);
  if (source === undefined) {
    throw new ConfigError("CONFIG_MISSING", "Repository config is missing at the base SHA");
  }
  return parseRepoConfig(source);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
