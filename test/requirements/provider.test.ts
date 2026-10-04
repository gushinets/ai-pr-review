import { expect, it } from "vitest";
import { noRequirements, linearRequirements } from "../../src/requirements/provider.js";
import { LinearRequirementsLoader } from "../../src/linear/requirements-loader.js";

it("none loads explicit absent requirements without invoking Linear", async () => {
  expect(await noRequirements.load(null)).toMatchObject({ identifier: null, comments: [] });
  await expect(noRequirements.load("ANY-1")).rejects.toThrow();
});
it("keeps the existing Linear loader and private normalized context", async () => {
  const loader = new LinearRequirementsLoader({
    exchangeToken: async () => "fake",
    createClient: () => ({
      issue: async (identifier) => ({
        identifier,
        title: "Private title",
        description: "Requirements",
        comments: async () => ({ nodes: [], pageInfo: { hasNextPage: false } }),
      }),
    }),
  });
  expect(
    await linearRequirements(loader, { clientId: "fake", clientSecret: "fake" }).load("ANY-1"),
  ).toMatchObject({ identifier: "ANY-1", title: "Private title" });
});
