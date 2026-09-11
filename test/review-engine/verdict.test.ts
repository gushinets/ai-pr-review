import { describe, expect, it } from "vitest";
import type { ReviewFindingV1 } from "../../src/contracts/review-state.js";
import type { ResolutionResultV1 } from "../../src/contracts/resolution-result.js";
import { computeFinalVerdict, computeFreshVerdict } from "../../src/review-engine/verdict.js";

const blocker: ReviewFindingV1 = {
  finding_id: "a",
  source_index: 0,
  severity: "blocking",
  confidence: "high",
  title: "issue",
  location: null,
  publication_location: null,
  basis: ["code"],
  evidence: "observed",
  rationale: "matters",
  remediation: "fix",
};
const previousBlockers = [blocker, { ...blocker, finding_id: "b" }];
function closure(statuses: readonly string[]): ResolutionResultV1 {
  return {
    schema_version: 1,
    resolutions: statuses.map((status, index) => ({
      previous_finding_id: index === 0 ? "a" : "b",
      status,
      confidence: "high",
      current_location: null,
      evidence: "Current evidence",
    })),
  } as ResolutionResultV1;
}

describe("deterministic verdicts", () => {
  it("blocks only when a fresh validated finding is blocking, independent of anchoring", () => {
    expect(computeFreshVerdict([])).toBe("PASS");
    expect(computeFreshVerdict([{ ...blocker, severity: "non_blocking", confidence: "low" }])).toBe(
      "PASS",
    );
    expect(computeFreshVerdict([blocker])).toBe("BLOCK");
  });

  it.each([
    [["resolved", "invalidated"], "PASS"],
    [["resolved", "resolved"], "PASS"],
    [["invalidated", "invalidated"], "PASS"],
    [["still_present", "resolved"], "BLOCK"],
    [["uncertain", "still_present"], "BLOCK"],
    [["resolved", "uncertain"], "UNABLE_TO_REVIEW"],
  ] as const)("aggregates %j as %s", (statuses, want) => {
    expect(
      computeFinalVerdict({ fresh: "PASS", previousBlockers, resolutions: closure(statuses) }),
    ).toBe(want);
  });

  it("passes fresh results when there is no historical obligation", () => {
    expect(computeFinalVerdict({ fresh: "PASS", previousBlockers: [], resolutions: null })).toBe(
      "PASS",
    );
  });

  it.each([
    null,
    closure([]),
    closure(["resolved"]),
    closure(["resolved", "invented"]),
    { ...closure(["resolved", "resolved"]), extra: true },
    {
      schema_version: 1,
      resolutions: [closure(["resolved"]).resolutions[0], closure(["resolved"]).resolutions[0]],
    },
    {
      schema_version: 1,
      resolutions: [
        { ...closure(["resolved"]).resolutions[0], previous_finding_id: "unknown" },
        closure(["resolved", "resolved"]).resolutions[1],
      ],
    },
    {
      schema_version: 1,
      resolutions: [
        { ...closure(["resolved"]).resolutions[0], confidence: "low" },
        closure(["resolved", "resolved"]).resolutions[1],
      ],
    },
  ])("fails closed on missing or invalid required closure %#", (resolutions) => {
    expect(
      computeFinalVerdict({
        fresh: "PASS",
        previousBlockers,
        resolutions: resolutions as ResolutionResultV1 | null,
      }),
    ).toBe("UNABLE_TO_REVIEW");
    expect(
      computeFinalVerdict({
        fresh: "BLOCK",
        previousBlockers,
        resolutions: resolutions as ResolutionResultV1 | null,
      }),
    ).toBe("BLOCK");
  });

  it("never clears fresh blockers when all historical blockers close", () => {
    expect(
      computeFinalVerdict({
        fresh: "BLOCK",
        previousBlockers,
        resolutions: closure(["resolved", "invalidated"]),
      }),
    ).toBe("BLOCK");
  });
});
