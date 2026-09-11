import { validateJudgeResult, type JudgeResultV1 } from "../contracts/judge-result.js";
import {
  validateResolutionResult,
  type ResolutionResultV1,
} from "../contracts/resolution-result.js";

export interface SanitizationSources {
  privateTexts: string[];
  secretValues: string[];
}

function normalize(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- remove C0/C1 controls except LF/TAB.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  );
}

export function sanitizeDurableText(text: string, sources: SanitizationSources): string {
  text = normalize(text);
  const candidate = text.replace(/\s+/g, " ").trim();
  const tokens = candidate.split(" ");
  if (/\bRun\s+ID\s*:/i.test(text)) return "[REDACTED PRIVATE SOURCE]";
  // Match before replacing credentials: substitutions must not hide a private quote.
  for (const raw of sources.privateTexts) {
    const source = normalize(raw).replace(/\s+/g, " ").trim();
    if (!source) continue;
    if (candidate.includes(source)) return "[REDACTED PRIVATE SOURCE]";
    // ponytail: direct window scans suit bounded V1 context; index sources if profiling warrants it.
    for (let start = 0; start + 80 <= candidate.length; start++) {
      if (source.includes(candidate.slice(start, start + 80))) return "[REDACTED PRIVATE SOURCE]";
    }
    for (let start = 0; start + 12 <= tokens.length; start++) {
      if (` ${source} `.includes(` ${tokens.slice(start, start + 12).join(" ")} `))
        return "[REDACTED PRIVATE SOURCE]";
    }
  }
  for (const secret of sources.secretValues
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\bauthorization["']?[ \t]*[:=][^\n]*/gi, "[REDACTED]")
    .replace(/\bbearer[ \t]+[^\s,;"']+/gi, "[REDACTED]")
    .replace(
      /\b(?:[a-z0-9_-]*(?:token|secret|password)|[a-z0-9_-]*api[-_ ]?key)["']?[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "[REDACTED]",
    )
    .replace(/\n(?:[ \t]*\n){4,}/g, "\n\n\n\n");
}

// Fixed fields cannot be rewritten; reject rather than corrupt IDs, enums, or locations.
export function assertDurableValues(value: unknown, sources: SanitizationSources): void {
  const serialized = JSON.stringify(value);
  if (
    serialized !== undefined &&
    sources.secretValues.some((secret) => secret && serialized.includes(secret))
  )
    throw new Error("INTERNAL_ERROR");
  function visit(item: unknown): void {
    if (typeof item === "string") {
      if (sanitizeDurableText(item, sources) !== item) throw new Error("INTERNAL_ERROR");
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) visit(child);
    }
  }
  visit(value);
}

export function sanitizeJudgeResult(
  result: JudgeResultV1,
  sources: SanitizationSources,
): JudgeResultV1 {
  if (!validateJudgeResult(result).ok) throw new Error("INTERNAL_ERROR");
  const sanitized = structuredClone(result);
  sanitized.summary = sanitizeDurableText(sanitized.summary, sources);
  for (const finding of sanitized.findings) {
    for (const field of ["title", "evidence", "rationale", "remediation"] as const)
      finding[field] = sanitizeDurableText(finding[field], sources);
  }
  if (!validateJudgeResult(sanitized).ok) throw new Error("INTERNAL_ERROR");
  assertDurableValues(sanitized, sources);
  return sanitized;
}

export function sanitizeResolutionResult(
  result: ResolutionResultV1,
  sources: SanitizationSources,
): ResolutionResultV1 {
  if (!validateResolutionResult(result).ok) throw new Error("INTERNAL_ERROR");
  const sanitized = structuredClone(result);
  for (const resolution of sanitized.resolutions)
    resolution.evidence = sanitizeDurableText(resolution.evidence, sources);
  if (!validateResolutionResult(sanitized).ok) throw new Error("INTERNAL_ERROR");
  assertDurableValues(sanitized, sources);
  return sanitized;
}
