import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runGraphProcess } from "../../src/graph/prepare.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit("close", null);
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

it("preserves JSON paths and symbols when stdout and stderr split every UTF-8 byte", async () => {
  const child = childProcess();
  const stdout =
    JSON.stringify({
      version: "1.6.1",
      truncated: false,
      symbols: [
        {
          id: "s1",
          file: "src/сумма一.ts",
          name: "сумма一𝛑",
          kind: "function",
          start_line: 1,
          end_line: 1,
        },
      ],
      edges: [],
      changed_symbol_ids: ["s1"],
      impacted_symbol_ids: ["s1"],
      file_dependants: [],
      affected_files: ["src/сумма一.ts"],
      affected_tests: [],
      boundaries: [],
    }) + "\n";
  const stderr = "предупреждение 一𝛑\n";
  const result = runGraphProcess({
    command: "graph",
    args: [],
    env: {},
    timeoutMs: 500,
    maxOutputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
  });
  for (const byte of Buffer.from(stdout)) child.stdout.write(Buffer.from([byte]));
  for (const byte of Buffer.from(stderr)) child.stderr.write(Buffer.from([byte]));
  child.emit("close", 0);
  expect(await result).toEqual({
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    outputLimit: false,
  });
  expect(JSON.parse((await result).stdout)).toMatchObject({
    symbols: [{ file: "src/сумма一.ts", name: "сумма一𝛑" }],
    affected_files: ["src/сумма一.ts"],
  });
  expect(child.kill).not.toHaveBeenCalled();
});

it("counts combined stdout and stderr bytes before accepting a multibyte chunk", async () => {
  const child = childProcess();
  const result = runGraphProcess({
    command: "graph",
    args: [],
    env: {},
    timeoutMs: 500,
    maxOutputBytes: 3,
  });
  child.stdout.write(Buffer.from("я"));
  child.stderr.write(Buffer.from("一"));
  expect(await result).toMatchObject({ stdout: "я", stderr: "", outputLimit: true });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
