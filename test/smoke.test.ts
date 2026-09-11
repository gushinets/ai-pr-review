import { describe, expect, it } from "vitest";
import { engineName } from "../src/index.js";

describe("repository scaffold", () => {
  it("exports the engine name", () => {
    expect(engineName).toBe("ai-pr-review");
  });
});
