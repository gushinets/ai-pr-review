import { expect, it } from "vitest";
import { parseReviewRequest } from "../../src/contracts/review-request.js";

export const request = {
  schema_version: 2,
  repository: "owner/repo",
  prNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  baseBranch: "main",
  trigger: {
    kind: "app",
    actor: "maintainer",
    installationId: 1,
    commentId: 2,
    deliveryId: "delivery-1",
  },
  requirementsSource: { kind: "none" },
  graphMode: "off",
  execution: "canonical",
} as const;
it("accepts an exact transport independent request", () => {
  expect(parseReviewRequest(JSON.stringify(request))).toEqual(request);
});
it.each([
  { ...request, repository: "../repo" },
  { ...request, headSha: "moving-branch" },
  { ...request, trigger: { ...request.trigger, installationId: 0 } },
  { ...request, extra: "ignored" },
  { ...request, graphMode: "mcp" },
  { ...request, requirementsSource: { kind: "linear", identifier: "ENG-1" } },
  { ...request, execution: "shadow" },
  { ...request, baseBranch: "main\n" },
])("rejects unsafe request %#", (value) => {
  expect(() => parseReviewRequest(JSON.stringify(value))).toThrow("INVALID_REVIEW_REQUEST");
});
