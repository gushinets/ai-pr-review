export type ReviewOutcome = "PASS" | "BLOCK" | "UNABLE_TO_REVIEW" | "STALE_SKIPPED";
export type PersistedOutcome = Exclude<ReviewOutcome, "STALE_SKIPPED">;
export type FindingSeverity = "blocking" | "non_blocking";
export type FindingConfidence = "high" | "medium" | "low";
export type FindingBasis = "code" | "ci" | "requirements" | "policy";
export type DiffSide = "LEFT" | "RIGHT";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const isRepositoryRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  !value.split("/").includes("..");
