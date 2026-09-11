import type { ReviewFindingV1 } from "../contracts/review-state.js";
import type { ResolutionResultV1 } from "../contracts/resolution-result.js";
import { validateResolutionResultForIds } from "./resolution-result.js";

export function computeFreshVerdict(findings: readonly ReviewFindingV1[]): "PASS" | "BLOCK" {
  return findings.some((finding) => finding.severity === "blocking") ? "BLOCK" : "PASS";
}

export function computeFinalVerdict(input: {
  fresh: "PASS" | "BLOCK";
  previousBlockers: readonly ReviewFindingV1[];
  resolutions: ResolutionResultV1 | null;
}): "PASS" | "BLOCK" | "UNABLE_TO_REVIEW" {
  if (input.fresh === "BLOCK") return "BLOCK";
  if (input.previousBlockers.length === 0) return "PASS";
  let resolutions: ResolutionResultV1;
  try {
    resolutions = validateResolutionResultForIds(
      input.resolutions,
      new Set(input.previousBlockers.map((finding) => finding.finding_id)),
    );
  } catch {
    return "UNABLE_TO_REVIEW";
  }
  if (resolutions.resolutions.some((resolution) => resolution.status === "still_present"))
    return "BLOCK";
  if (resolutions.resolutions.some((resolution) => resolution.status === "uncertain"))
    return "UNABLE_TO_REVIEW";
  return "PASS";
}
