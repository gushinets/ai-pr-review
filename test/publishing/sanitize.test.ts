import { describe, expect, it } from "vitest";
import type { JudgeResultV1 } from "../../src/contracts/judge-result.js";
import type { ResolutionResultV1 } from "../../src/contracts/resolution-result.js";
import {
  sanitizeDurableText,
  sanitizeJudgeResult,
  sanitizeResolutionResult,
} from "../../src/publishing/sanitize.js";

const sources = {
  privateTexts: [
    "PRIVATE_LINEAR_REQUIREMENT_7e57 The provider token must be rotated before migration.",
    "PRIVATE_CI_LOG_4a92 database password=supersecret-value",
  ],
  secretValues: ["qwen-secret-123", "linear-secret-456", "github-secret-789"],
};
const empty = { privateTexts: [], secretValues: [] };
const judge: JudgeResultV1 = {
  schema_version: 1,
  summary: "Summary",
  findings: [
    {
      severity: "blocking",
      confidence: "high",
      title: "Title",
      location: { path: "src/a.ts", line: 1, side: "RIGHT" },
      basis: ["code", "requirements"],
      evidence: "Evidence",
      rationale: "Rationale",
      remediation: "Remediation",
    },
  ],
};
const closure: ResolutionResultV1 = {
  schema_version: 1,
  resolutions: [
    {
      previous_finding_id: "stable-id",
      status: "resolved",
      confidence: "high",
      current_location: { path: "src/a.ts", line: 1, side: "RIGHT" },
      evidence: "Evidence",
    },
  ],
};

describe("durable text privacy", () => {
  it("normalizes controls and limits blank lines without removing LF/TAB", () => {
    expect(
      sanitizeDurableText(
        "a\r\nb\rc\t\u0000\u0008\u000b\u001f\u007f\u0085\u009f\n\n\n\n\nend",
        empty,
      ),
    ).toBe("a\nb\nc\t\n\n\n\nend");
  });
  it("redacts every exact secret, longest first, including normalized secret values", () => {
    expect(
      sanitizeDurableText("abc-long abc x\r\ny", {
        privateTexts: [],
        secretValues: ["", "abc", "abc-long", "x\r\ny"],
      }),
    ).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });
  it.each([
    "Bearer unknown-value",
    "token=unknown-value",
    "client_secret: unknown-value",
    "password='unknown-value'",
    'API-key="unknown-value"',
    '"api_key": "unknown-value"',
    "Authorization: Basic unknown-value",
  ])("redacts credential fragment %s", (text) => {
    expect(sanitizeDurableText(text, empty)).not.toContain("unknown-value");
  });
  it.each(sources.privateTexts)(
    "redacts complete private source before credential substitutions",
    (source) => {
      expect(sanitizeDurableText(`Observed: ${source} End.`, sources)).toBe(
        "[REDACTED PRIVATE SOURCE]",
      );
    },
  );
  it("matches any 80-character window, but does not redact 79 characters", () => {
    const privateText = `start ${"x".repeat(90)} end`;
    expect(
      sanitizeDurableText(`prefix ${"x".repeat(80)} suffix`, {
        ...empty,
        privateTexts: [privateText],
      }),
    ).toBe("[REDACTED PRIVATE SOURCE]");
    expect(sanitizeDurableText("x".repeat(79), { ...empty, privateTexts: [privateText] })).toBe(
      "x".repeat(79),
    );
  });
  it("matches 12 contiguous tokens with normalized whitespace, but not 11 or partial tokens", () => {
    const source = "start a b c d e f g h i j k l end";
    const context = { ...empty, privateTexts: [source] };
    expect(sanitizeDurableText("prefix a\r\nb\tc d e f g h i j k l suffix", context)).toBe(
      "[REDACTED PRIVATE SOURCE]",
    );
    expect(sanitizeDurableText("a b c d e f g h i j k", context)).toBe("a b c d e f g h i j k");
    expect(sanitizeDurableText("xa b c d e f g h i j k lz", context)).toBe(
      "xa b c d e f g h i j k lz",
    );
  });
  it("normalizes both private sources and candidate character windows", () => {
    const phrase = "abcdefghij ".repeat(9);
    expect(
      sanitizeDurableText(`prefix ${phrase} suffix`, {
        ...empty,
        privateTexts: [`start ${phrase.replaceAll(" ", "\r\n\t\u0000")} end`],
      }),
    ).toBe("[REDACTED PRIVATE SOURCE]");
    expect(
      sanitizeDurableText("Safe text", { privateTexts: ["", " \n\t"], secretValues: [""] }),
    ).toBe("Safe text");
  });
  it("removes transcript scaffolding even without a private source", () => {
    expect(
      sanitizeDurableText("Result\nRun ID: private-session\nReviewer: raw report", empty),
    ).toBe("[REDACTED PRIVATE SOURCE]");
  });
});

describe("structured durable privacy", () => {
  it.each(["summary", "title", "evidence", "rationale", "remediation"] as const)(
    "sanitizes judge %s and preserves fixed fields without mutating input",
    (field) => {
      const input = structuredClone(judge);
      const raw = `${sources.privateTexts.join("\n")} ${sources.secretValues.join(" ")}`;
      if (field === "summary") input.summary = raw;
      else input.findings[0]![field] = raw;
      const before = structuredClone(input);
      const result = sanitizeJudgeResult(input, sources);
      expect(field === "summary" ? result.summary : result.findings[0]![field]).toBe(
        "[REDACTED PRIVATE SOURCE]",
      );
      expect(result.findings[0]!.location).toEqual(judge.findings[0]!.location);
      expect(result.findings[0]!.basis).toEqual(["code", "requirements"]);
      expect(result.findings[0]!.severity).toBe("blocking");
      expect(result.findings[0]!.confidence).toBe("high");
      expect(result.schema_version).toBe(1);
      expect(input).toEqual(before);
    },
  );
  it("sanitizes closure evidence while keeping stable IDs/status/location", () => {
    const input = structuredClone(closure);
    input.resolutions[0]!.evidence = "github-secret-789";
    expect(sanitizeResolutionResult(input, sources)).toEqual({
      ...closure,
      resolutions: [{ ...closure.resolutions[0]!, evidence: "[REDACTED]" }],
    });
    expect(input.resolutions[0]!.evidence).toBe("github-secret-789");
  });
  it("revalidates and rejects required text emptied by normalization", () => {
    expect(() => sanitizeJudgeResult({ ...judge, summary: "\u0000" }, empty)).toThrow(
      /^INTERNAL_ERROR$/,
    );
    expect(() =>
      sanitizeResolutionResult(
        { ...closure, resolutions: [{ ...closure.resolutions[0]!, evidence: "\u0000" }] },
        empty,
      ),
    ).toThrow(/^INTERNAL_ERROR$/);
  });
  it("fails closed when immutable locations or IDs would leak", () => {
    expect(() =>
      sanitizeJudgeResult(
        {
          ...judge,
          findings: [
            {
              ...judge.findings[0]!,
              location: { path: "qwen-secret-123.ts", line: 1, side: "RIGHT" },
            },
          ],
        },
        sources,
      ),
    ).toThrow(/^INTERNAL_ERROR$/);
    expect(() =>
      sanitizeResolutionResult(
        {
          ...closure,
          resolutions: [{ ...closure.resolutions[0]!, previous_finding_id: "github-secret-789" }],
        },
        sources,
      ),
    ).toThrow(/^INTERNAL_ERROR$/);
    expect(() =>
      sanitizeResolutionResult(
        {
          ...closure,
          resolutions: [
            {
              ...closure.resolutions[0]!,
              current_location: { path: "linear-secret-456.ts", line: 1, side: "RIGHT" },
            },
          ],
        },
        sources,
      ),
    ).toThrow(/^INTERNAL_ERROR$/);
  });
  it("rejects a secret that collides with the redaction marker", () => {
    expect(() =>
      sanitizeJudgeResult(
        { ...judge, summary: "[REDACTED]" },
        { ...empty, secretValues: ["[REDACTED]"] },
      ),
    ).toThrow(/^INTERNAL_ERROR$/);
  });
});
