import { describe, expect, it } from "vitest";
import {
  artifactName,
  STATE_FILE_NAME,
  STATE_RETENTION_DAYS,
} from "../../src/state/artifact-name.js";

describe("canonical artifact naming", () => {
  it("supplies the single upload name, file and ninety-day retention", () => {
    expect({
      name: artifactName(17),
      file: STATE_FILE_NAME,
      retention: STATE_RETENTION_DAYS,
    }).toEqual({
      name: "ai-review-state-v1-pr-17",
      file: "ai-review-state-v1.json",
      retention: 90,
    });
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid PR number %s",
    (number) => {
      expect(() => artifactName(number)).toThrow();
    },
  );
});
