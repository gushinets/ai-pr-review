import { expect, it } from "vitest";
import { parseReviewRequest } from "../../src/contracts/review-request.js";

export const request = {
  schema_version: 2,
  repository: "owner/repo",
  prNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  engineSha: "e".repeat(40),
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
it("requires a trusted engine commit for App requests and permits internal resolution", () => {
  const { engineSha: _engineSha, ...unpinned } = request;
  expect(() => parseReviewRequest(JSON.stringify(unpinned))).toThrow("INVALID_REVIEW_REQUEST");
  expect(
    parseReviewRequest(
      JSON.stringify({ ...unpinned, trigger: { kind: "internal", actor: "maintainer" } }),
    ).engineSha,
  ).toBeUndefined();
});
it("accepts GitHub's dot-prefixed repository names", () => {
  expect(
    parseReviewRequest(JSON.stringify({ ...request, repository: "owner/.github" })).repository,
  ).toBe("owner/.github");
});
it.each([
  { ...request, repository: "../repo" },
  { ...request, repository: "owner/.." },
  { ...request, headSha: "moving-branch" },
  { ...request, engineSha: "moving-branch" },
  { ...request, trigger: { ...request.trigger, installationId: 0 } },
  { ...request, extra: "ignored" },
  { ...request, graphMode: "mcp" },
  { ...request, requirementsSource: { kind: "linear", identifier: "ENG-1" } },
  { ...request, execution: "shadow" },
  { ...request, baseBranch: "main\n" },
])("rejects unsafe request %#", (value) => {
  expect(() => parseReviewRequest(JSON.stringify(value))).toThrow("INVALID_REVIEW_REQUEST");
});
