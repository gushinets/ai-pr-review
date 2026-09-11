import { CENTRAL_CONFIG } from "../config/central-config.js";

export const STATE_FILE_NAME = "ai-review-state-v1.json";
export const STATE_RETENTION_DAYS = CENTRAL_CONFIG.artifactRetentionDays;

export function artifactName(prNumber: number): string {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Invalid PR number");
  return `ai-review-state-v1-pr-${prNumber}`;
}
