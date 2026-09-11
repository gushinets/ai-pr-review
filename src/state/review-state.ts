import { validateReviewState, type ReviewStateV1 } from "../contracts/review-state.js";

// Inputs must already be sanitized; this boundary validates structure, not private values.
export function buildReviewState(input: Omit<ReviewStateV1, "schema_version">): ReviewStateV1 {
  const validated = validateReviewState({ schema_version: 1, ...input });
  if (!validated.ok) throw new Error("Invalid ReviewStateV1");
  return structuredClone(validated.value);
}

export function parseReviewState(input: string): ReviewStateV1 {
  try {
    const validated = validateReviewState(JSON.parse(input));
    if (validated.ok) return validated.value;
  } catch {
    // Never echo artifact contents or parser messages into public diagnostics.
  }
  throw new Error("STATE_LOAD_FAILED");
}
