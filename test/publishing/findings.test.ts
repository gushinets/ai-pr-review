import { describe, expect, it } from "vitest";
import type { JudgeFindingV1, JudgeResultV1 } from "../../src/contracts/judge-result.js";
import type { ReviewIdentityV1 } from "../../src/contracts/review-identity.js";
import { buildDiffIndex } from "../../src/github/diff.js";
import { buildReviewFindings } from "../../src/publishing/findings.js";

const identity: ReviewIdentityV1 = {
  repository: "o/r",
  pr_number: 7,
  base_sha: "b".repeat(40),
  head_sha: "a".repeat(40),
  engine_sha: "c".repeat(40),
  linear_issue: "ANY-1",
};
const finding: JudgeFindingV1 = {
  severity: "blocking",
  confidence: "high",
  title: "Missing check",
  location: { path: "src/a.ts", line: 11, side: "RIGHT" },
  basis: ["code"],
  evidence: "Unchecked input",
  rationale: "Invalid state",
  remediation: "Validate",
};
const result: JudgeResultV1 = { schema_version: 1, summary: "One issue", findings: [finding] };
const diff = buildDiffIndex(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +10,3 @@\n old\n-removed\n+added\n+added2",
);

describe("wrapper findings", () => {
  it("uses the specified SHA-256 input and 24 hex characters", () => {
    const findings = buildReviewFindings(result, identity, diff);
    expect(findings[0]).toMatchObject({
      finding_id: "5915ffbefaa77dac9c17bec0",
      source_index: 0,
      publication_location: finding.location,
    });
    expect(buildReviewFindings(result, identity, diff)).toEqual(findings);
  });

  it("keeps repeated findings separate by source index and changes IDs on a new head", () => {
    const findings = buildReviewFindings(
      { ...result, findings: [finding, finding] },
      identity,
      diff,
    );
    expect(findings.map((entry) => entry.source_index)).toEqual([0, 1]);
    expect(new Set(findings.map((entry) => entry.finding_id)).size).toBe(2);
    expect(
      buildReviewFindings(result, { ...identity, head_sha: "d".repeat(40) }, diff)[0]?.finding_id,
    ).not.toBe(findings[0]?.finding_id);
  });

  it.each([
    [null, false],
    [{ path: "src/a.ts", line: 11, side: "LEFT" }, true],
    [{ path: "src/a.ts", line: 12, side: "RIGHT" }, true],
    [{ path: "src/a.ts", line: 12, side: "LEFT" }, false],
    [{ path: "src/a.ts", line: 99, side: "RIGHT" }, false],
    [{ path: "other.ts", line: 11, side: "RIGHT" }, false],
    [{ path: "target/src/a.ts", line: 11, side: "RIGHT" }, false],
  ] as const)("publishes only locations contained in the exact diff %#", (location, anchorable) => {
    const original: JudgeResultV1 = { ...result, findings: [{ ...finding, location }] };
    const before = structuredClone(original);
    const wrapped = buildReviewFindings(original, identity, diff)[0];
    expect(wrapped?.publication_location).toEqual(anchorable ? location : null);
    expect(wrapped?.location).toEqual(location);
    expect(original).toEqual(before);
  });

  it("hashes a null model location as empty path/line/side fields", () => {
    expect(
      buildReviewFindings(
        { ...result, findings: [{ ...finding, location: null }] },
        identity,
        diff,
      )[0]?.finding_id,
    ).toBe("fb3c419b245922e19160e3a7");
  });
});
