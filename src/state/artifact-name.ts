import { CENTRAL_CONFIG } from "../config/central-config.js";
import { createHash } from "node:crypto";

export const STATE_FILE_NAME = "ai-review-state-v1.json";
export const STATE_RETENTION_DAYS = CENTRAL_CONFIG.artifactRetentionDays;

export function artifactName(prNumber: number): string {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Invalid PR number");
  return `ai-review-state-v1-pr-${prNumber}`;
}
export function centralArtifactName(repository: string, prNumber: number): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository");
  const target = createHash("sha256").update(repository.toLowerCase()).digest("hex");
  return `ai-review-state-v2-${target}-pr-${artifactName(prNumber).split("-pr-")[1]}`;
}
