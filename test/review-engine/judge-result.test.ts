import { describe, expect, it, vi } from "vitest";
import type { JudgeFindingV1 } from "../../src/contracts/judge-result.js";
import {
  buildJudgeOutputInstructions,
  buildJudgeRepairPrompt,
} from "../../src/context/review-context.js";
import {
  getValidJudgeResult,
  JudgeProtocolError,
  parseJudgeResult,
} from "../../src/review-engine/judge-result.js";
import { RejudgeEngineError, type RejudgeEngine } from "../../src/review-engine/rejudge-engine.js";

const finding: JudgeFindingV1 = {
  severity: "blocking",
  confidence: "high",
  title: "Missing check",
  location: { path: "src/a.ts", line: 2, side: "RIGHT" },
  basis: ["code"],
  evidence: "Input is unchecked",
  rationale: "Invalid input reaches storage",
  remediation: "Validate input",
};
const result = { schema_version: 1, summary: "One issue", findings: [finding] };
const raw = JSON.stringify(result);
const withFinding = (change: Record<string, unknown>) =>
  JSON.stringify({ ...result, findings: [{ ...finding, ...change }] });

describe("parseJudgeResult", () => {
  it("accepts complete JSON with surrounding JSON whitespace without changing content", () => {
    expect(parseJudgeResult(" \n" + raw + "\t")).toEqual(result);
    expect(parseJudgeResult('{"schema_version":1,"summary":"ok","findings":[]}').findings).toEqual(
      [],
    );
    expect(
      parseJudgeResult(withFinding({ location: null, severity: "non_blocking", confidence: "low" }))
        .findings[0]?.location,
    ).toBeNull();
    expect(
      parseJudgeResult(JSON.stringify({ ...result, findings: Array(20).fill(finding) })).findings,
    ).toHaveLength(20);
  });

  it.each([
    ["fences", "\x60\x60\x60json\n" + raw + "\n\x60\x60\x60"],
    ["leading prose", "Here: " + raw],
    ["trailing prose", raw + " done"],
    ["two objects", raw + raw],
    ["array", "[" + raw + "]"],
    ["null", "null"],
    ["trailing comma", raw.replace(',"findings"', ',,"findings"')],
    ["verdict", JSON.stringify({ ...result, verdict: "PASS" })],
    ["version", JSON.stringify({ ...result, schema_version: 2 })],
    ["missing summary", '{"schema_version":1,"findings":[]}'],
    ["blank summary", JSON.stringify({ ...result, summary: " \n" })],
    ["21 findings", JSON.stringify({ ...result, findings: Array(21).fill(finding) })],
    ["unknown finding property", withFinding({ finding_id: "model-owned" })],
    ["severity", withFinding({ severity: "critical" })],
    ["confidence", withFinding({ confidence: "HIGH" })],
    ["basis", withFinding({ basis: ["unknown"] })],
    ["empty basis", withFinding({ basis: [] })],
    ...["medium", "low"].map((confidence) => [
      "blocking " + confidence,
      withFinding({ confidence }),
    ]),
    ...["title", "evidence", "rationale", "remediation"].flatMap((key) =>
      ["", " \n\t"].map((value) => ["empty " + key, withFinding({ [key]: value })]),
    ),
    ...[0, -1, 1.5].map((line) => [
      "line " + line,
      withFinding({ location: { ...finding.location, line } }),
    ]),
    ...["/etc/passwd", "../a.ts", "src/../a.ts", "C:/a.ts", "src\\a.ts"].map((path) => [
      "unsafe path " + path,
      withFinding({ location: { ...finding.location, path } }),
    ]),
    ["side", withFinding({ location: { ...finding.location, side: "right" } })],
    ["location property", withFinding({ location: { ...finding.location, column: 1 } })],
  ])("rejects %s", (_label, answer) => {
    expect(() => parseJudgeResult(answer!)).toThrow(JudgeProtocolError);
  });

  it("reports a bounded schema/semantic path without raw model values or unknown keys", () => {
    for (const answer of [
      withFinding({ title: "" }),
      withFinding({ confidence: "medium" }),
      JSON.stringify({ ...result, ["SECRET".repeat(1000)]: "PRIVATE_RESPONSE" }),
      "PRIVATE_RESPONSE " + raw,
    ]) {
      try {
        parseJudgeResult(answer);
        expect.fail("must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(JudgeProtocolError);
        expect(error).toMatchObject({ reason: "JUDGE_RESULT_INVALID" });
        expect((error as Error).message).toMatch(/\//);
        expect((error as Error).message).not.toMatch(/SECRET|PRIVATE_RESPONSE|Input is unchecked/);
        expect((error as Error).message.length).toBeLessThan(200);
      }
    }
    expect(() => parseJudgeResult(withFinding({ title: "" }))).toThrow(/\/findings\/0\/title/);
    expect(() => parseJudgeResult(withFinding({ confidence: "medium" }))).toThrow(/\/findings\/0/);
  });
});

const input = { reviewRoot: "/review", runtimeDir: "/runtime", prompt: "fresh review" };
function engine(answer = raw) {
  return {
    fresh: vi.fn<RejudgeEngine["fresh"]>().mockResolvedValue({ answer, run_id: "run-1" }),
    resume: vi.fn<RejudgeEngine["resume"]>().mockResolvedValue({ answer: raw, run_id: "run-1" }),
  };
}

describe("getValidJudgeResult", () => {
  it("returns validated fresh output without resuming", async () => {
    const runner = engine();
    expect(await getValidJudgeResult(runner, input)).toEqual({
      result,
      runId: "run-1",
      repairAttempts: 0,
    });
    expect(runner.fresh).toHaveBeenCalledExactlyOnceWith({
      ...input,
      outputInstructions: buildJudgeOutputInstructions(),
    });
    expect(runner.resume).not.toHaveBeenCalled();
  });

  it("repairs invalid output once in the same run with the owned repair prompt", async () => {
    const runner = engine("PRIVATE_RESPONSE");
    const repaired = await getValidJudgeResult(runner, input);
    expect(repaired).toEqual({ result, runId: "run-1", repairAttempts: 1 });
    expect(runner.fresh).toHaveBeenCalledTimes(1);
    const repairInput = runner.resume.mock.calls[0]?.[0];
    expect(runner.resume).toHaveBeenCalledTimes(1);
    expect(repairInput).toMatchObject({
      reviewRoot: input.reviewRoot,
      runtimeDir: input.runtimeDir,
      runId: "run-1",
      outputInstructions: buildJudgeOutputInstructions(),
    });
    let message = "";
    try {
      parseJudgeResult("PRIVATE_RESPONSE");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(repairInput?.prompt).toBe(buildJudgeRepairPrompt(message));
    expect(repairInput?.prompt).not.toContain("PRIVATE_RESPONSE");
  });

  it.each(["setup", "panel", "judge"] as const)(
    "preserves initial %s technical failure without any retry",
    async (stage) => {
      const runner = engine();
      runner.fresh.mockRejectedValue(new RejudgeEngineError(stage, "model"));
      await expect(getValidJudgeResult(runner, input)).rejects.toMatchObject({
        reason: stage === "judge" ? "REJUDGE_JUDGE_FAILED" : "REJUDGE_PANEL_FAILED",
        stage,
        model: "model",
      });
      expect(runner.fresh).toHaveBeenCalledTimes(1);
      expect(runner.resume).not.toHaveBeenCalled();
    },
  );

  it.each(["invalid", "technical", "wrong run"] as const)(
    "fails closed after a %s repair without another panel or resume",
    async (failure) => {
      const runner = engine("invalid");
      if (failure === "technical")
        runner.resume.mockRejectedValue(new RejudgeEngineError("resume"));
      else
        runner.resume.mockResolvedValue({
          answer: failure === "invalid" ? "PRIVATE_RESPONSE" : raw,
          run_id: failure === "wrong run" ? "other-run" : "run-1",
        });
      await expect(getValidJudgeResult(runner, input)).rejects.toMatchObject({
        reason: "JUDGE_REPAIR_FAILED",
        runId: "run-1",
        repairAttempts: 1,
      });
      expect(runner.fresh).toHaveBeenCalledTimes(1);
      expect(runner.resume).toHaveBeenCalledTimes(1);
    },
  );
});
