import { describe, expect, it } from "vitest";
import {
  parseResolutionResult,
  ResolutionProtocolError,
} from "../../src/review-engine/resolution-result.js";

const resolution = {
  previous_finding_id: "a",
  status: "resolved",
  confidence: "high",
  current_location: null,
  evidence: "Fixed in current head",
};
const result = {
  schema_version: 1,
  resolutions: [resolution, { ...resolution, previous_finding_id: "b", status: "invalidated" }],
};
const expected = new Set(["a", "b"]);

describe("parseResolutionResult", () => {
  it("accepts exactly one resolution per expected ID in any order", () => {
    expect(parseResolutionResult(JSON.stringify(result), expected)).toEqual(result);
    expect(
      parseResolutionResult(
        JSON.stringify({ ...result, resolutions: [...result.resolutions].reverse() }),
        expected,
      ).resolutions[0]?.previous_finding_id,
    ).toBe("b");
    expect(
      parseResolutionResult('{"schema_version":1,"resolutions":[]}', new Set()).resolutions,
    ).toEqual([]);
  });

  it.each([
    ["missing", [resolution]],
    ["duplicate", [resolution, resolution]],
    ["extra", [...result.resolutions, { ...resolution, previous_finding_id: "c" }]],
    ["substitution", [resolution, { ...resolution, previous_finding_id: "c" }]],
  ])("rejects %s IDs", (_label, resolutions) => {
    expect(() =>
      parseResolutionResult(JSON.stringify({ ...result, resolutions }), expected),
    ).toThrow(ResolutionProtocolError);
  });

  it.each([
    { schema_version: 2 },
    { extra: true },
    { resolutions: null },
    ...[
      { status: "fixed" },
      { confidence: "medium" },
      { confidence: "low" },
      { previous_finding_id: "" },
      { previous_finding_id: " " },
      { evidence: "" },
      { evidence: " \n" },
      { verdict: "PASS" },
      ...["../a", "/a", "C:/a"].map((path) => ({
        current_location: { path, line: 1, side: "RIGHT" },
      })),
      { current_location: { path: "a", line: 0, side: "RIGHT" } },
      { current_location: { path: "a", line: 1, side: "right" } },
    ].map((change) => ({ resolutions: [{ ...resolution, ...change }, result.resolutions[1]] })),
  ])("rejects invalid shape or semantics %#", (change) => {
    expect(() => parseResolutionResult(JSON.stringify({ ...result, ...change }), expected)).toThrow(
      ResolutionProtocolError,
    );
  });

  it.each(["null", "[]", "prefix", "\x60\x60\x60json\n", JSON.stringify(result) + " trailing"])(
    "rejects non-object or non-JSON output %#",
    (raw) => {
      expect(() => parseResolutionResult(raw, expected)).toThrow(ResolutionProtocolError);
    },
  );

  it("provides a safe validation path and reason without model evidence or IDs", () => {
    const bad = {
      ...result,
      resolutions: [
        { ...resolution, previous_finding_id: "PRIVATE_ID", evidence: "PRIVATE_EVIDENCE" },
      ],
    };
    try {
      parseResolutionResult(JSON.stringify(bad), expected);
      expect.fail("must reject");
    } catch (error) {
      expect(error).toMatchObject({ reason: "CLOSURE_RESULT_INVALID" });
      expect((error as Error).message).toContain("/resolutions");
      expect((error as Error).message).not.toMatch(/PRIVATE_/);
    }
  });
});
