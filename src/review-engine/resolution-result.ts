import Schema from "typebox/schema";
import {
  ResolutionResultV1Schema,
  validateResolutionResult,
  type ResolutionResultV1,
} from "../contracts/resolution-result.js";

export class ResolutionProtocolError extends Error {
  readonly reason = "CLOSURE_RESULT_INVALID";
  constructor(path: string, detail: string) {
    super(`CLOSURE_RESULT_INVALID at ${path}: ${detail}`);
  }
}

export function validateResolutionResultForIds(
  value: unknown,
  expectedFindingIds: ReadonlySet<string>,
): ResolutionResultV1 {
  const [valid, errors] = Schema.Errors(ResolutionResultV1Schema, value);
  if (!valid) {
    // Report the owning object, never an unknown model-supplied property name.
    const error = errors.find((entry) => entry.keyword === "additionalProperties") ?? errors[0];
    throw new ResolutionProtocolError(error?.instancePath || "/", "schema mismatch");
  }
  const checked = validateResolutionResult(value);
  if (!checked.ok) {
    const result = value as ResolutionResultV1;
    const index = result.resolutions.findIndex(
      (resolution) =>
        !validateResolutionResult({ schema_version: 1, resolutions: [resolution] }).ok,
    );
    throw new ResolutionProtocolError(`/resolutions/${index}`, "semantic invariant failed");
  }
  const seen = new Set<string>();
  for (const [index, resolution] of checked.value.resolutions.entries()) {
    const id = resolution.previous_finding_id;
    if (!expectedFindingIds.has(id) || seen.has(id)) {
      throw new ResolutionProtocolError(
        `/resolutions/${index}/previous_finding_id`,
        "unknown or duplicate ID",
      );
    }
    seen.add(id);
  }
  if (seen.size !== expectedFindingIds.size)
    throw new ResolutionProtocolError("/resolutions", "missing required IDs");
  return checked.value;
}

export function parseResolutionResult(
  raw: string,
  expectedFindingIds: ReadonlySet<string>,
): ResolutionResultV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResolutionProtocolError("/", "expected one JSON object");
  }
  return validateResolutionResultForIds(value, expectedFindingIds);
}
