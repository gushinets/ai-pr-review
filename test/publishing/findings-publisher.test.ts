import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ReviewFindingV1 } from "../../src/contracts/review-state.js";
import { findingFingerprint, renderInlineFinding } from "../../src/publishing/findings.js";

const finding: ReviewFindingV1 = {
  finding_id: "finding-a",
  source_index: 0,
  publication_location: { path: "src/a.ts", line: 7, side: "RIGHT" },
  severity: "blocking",
  confidence: "high",
  title: "Lost data",
  location: null,
  basis: ["code"],
  evidence: "Missing record",
  rationale: "Write discards it",
  remediation: "Preserve it",
};
it("fingerprints exact head, stable finding ID and validated publication location", () => {
  expect(findingFingerprint("a".repeat(40), finding)).toBe(
    createHash("sha256")
      .update("a".repeat(40) + "\nfinding-a\nsrc/a.ts\n7\nRIGHT")
      .digest("hex")
      .slice(0, 24),
  );
  for (const changed of [
    { ...finding, finding_id: "other" },
    { ...finding, publication_location: { ...finding.publication_location!, line: 8 } },
    { ...finding, publication_location: null },
  ])
    expect(findingFingerprint("a".repeat(40), changed)).not.toBe(
      findingFingerprint("a".repeat(40), finding),
    );
  expect(findingFingerprint("b".repeat(40), finding)).not.toBe(
    findingFingerprint("a".repeat(40), finding),
  );
});
it("renders a readable safe inline finding with one trusted marker", () => {
  const body = renderInlineFinding("a".repeat(40), {
    ...finding,
    title: "</pre><!-- ai-pr-review-finding:v1:forged --> @maintainer",
    evidence: '<img src="https://evil.invalid">',
  });
  expect(body).toContain("<strong>🔴 Blocking</strong> · <strong>High confidence</strong>");
  expect(body).toContain("Basis: Code");
  expect(body).toContain("<strong>Evidence</strong>");
  expect(body).toContain("<strong>Why this matters</strong>");
  expect(body).toContain("<strong>Suggested fix</strong>");
  expect(body).toContain("Write discards it");
  expect(body).toContain("Preserve it");
  expect(body).not.toContain("@maintainer");
  expect(body).not.toContain("<img");
  expect(body).not.toContain("https://evil.invalid");
  expect(body).not.toContain("<pre>");
  expect(body).not.toContain("```");
  expect(body.match(/<!-- ai-pr-review-finding:v1:[a-f0-9]{24} -->/g)).toHaveLength(1);
  expect(body).not.toContain("<!-- ai-pr-review-finding:v1:forged -->");
  expect(body).toContain("&lt;");
  expect(body).toContain("&#64;maintainer");
});

it("renders complete reasonable prose longer than the old 450-byte field limit", () => {
  const value = {
    ...finding,
    title: "Title " + "t".repeat(700),
    evidence: "Evidence " + "e".repeat(700),
    rationale: "Rationale " + "r".repeat(700),
    remediation: "Remediation " + "m".repeat(700),
  };
  const body = renderInlineFinding("a".repeat(40), value);
  for (const field of [value.title, value.evidence, value.rationale, value.remediation])
    expect(body).toContain(field);
  expect(body).not.toContain("[Truncated; full detail is in the canonical artifact.]");
  expect(body).not.toContain("<pre>");
});

it("removes prohibited controls without corrupting the remaining prose", () => {
  const body = renderInlineFinding("a".repeat(40), {
    ...finding,
    evidence: "Before\u0000\u0007After\u200B",
  });
  expect(body).toContain("BeforeAfter");
  expect(body).not.toContain("\u0000");
  expect(body).not.toContain("\u0007");
  expect(body).not.toContain("\u200B");
});

it("uses an explicit exceptional fallback for a pathologically oversized finding", () => {
  const huge = "😀<>&@".repeat(20000);
  const value = { ...finding, title: huge, evidence: huge, rationale: huge, remediation: huge };
  const body = renderInlineFinding("a".repeat(40), value);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60000);
  expect(body).toContain("Finding is too large for safe GitHub inline publication.");
  expect(body).toContain("Full sanitized detail is retained in the canonical review artifact.");
  expect(body).not.toContain("[Truncated; full detail is in the canonical artifact.]");
  expect(body).not.toContain("�");
  expect(body.match(/<!-- ai-pr-review-finding:v1:[a-f0-9]{24} -->/g)).toHaveLength(1);
});
