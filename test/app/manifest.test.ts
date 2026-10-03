import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships a private target App with only review and publication permissions", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../app/manifest.json", import.meta.url), "utf8"),
  );
  expect(manifest.public).toBe(false);
  expect(manifest.default_permissions).toEqual({
    metadata: "read",
    contents: "read",
    pull_requests: "write",
    issues: "read",
    checks: "write",
    statuses: "read",
    actions: "read",
  });
  expect(manifest.default_events).toEqual(["issue_comment"]);
});

it("ships a private dispatcher App with central dispatch and engine commit read permissions", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../app/dispatch-manifest.json", import.meta.url), "utf8"),
  );
  expect(manifest.public).toBe(false);
  expect(manifest.default_permissions).toEqual({
    metadata: "read",
    contents: "read",
    actions: "write",
  });
  expect(manifest.default_events).toEqual([]);
  expect(manifest.hook_attributes.active).toBe(false);
});
