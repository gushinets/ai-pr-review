import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SqliteCommandLedger } from "../../src/app/command-ledger.js";

const identity = {
  repository: "owner/repo",
  prNumber: 5,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  engineSha: "e".repeat(40),
};
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function legacy(status = "completed") {
  const dir = mkdtempSync(join(tmpdir(), "legacy-command-ledger-"));
  const path = join(dir, "commands.sqlite");
  const ledger = new SqliteCommandLedger(path);
  cleanup.push(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(path);
  const key = JSON.stringify(["owner/repo", 5, "a".repeat(40), "b".repeat(40)]);
  db.prepare("INSERT INTO commands VALUES (?, ?, ?)").run(key, "legacy-delivery", status);
  db.prepare("INSERT INTO deliveries VALUES (?, ?)").run("legacy-delivery", key);
  db.prepare("INSERT INTO deliveries VALUES (?, ?)").run("legacy-duplicate", key);
  db.prepare("INSERT INTO accepted_comments VALUES (?, ?)").run("owner/repo", 71);
  db.close();
  return { ledger, path, key };
}

it.each(["claimed", "dispatched", "uncertain", "completed"])(
  "holds legacy %s claims for every engine without erasing tombstones",
  (status) => {
    const { ledger } = legacy(status);
    expect(ledger.claim("engine-a", identity, 72)).toBe("DUPLICATE_COMMAND");
    expect(ledger.claim("engine-b", { ...identity, engineSha: "f".repeat(40) }, 73)).toBe(
      "DUPLICATE_COMMAND",
    );
    expect(ledger.commandStatus("legacy-delivery")).toBe(status);
    expect(ledger.hasDelivery("legacy-delivery")).toBe(true);
    expect(ledger.hasComment("owner/repo", 71)).toBe(true);
  },
);
it("binds a completed legacy claim to an operator-verified engine, preserving all tombstones", () => {
  const { ledger, path } = legacy();
  ledger.bindLegacyCompletedEngine("legacy-delivery", "e".repeat(40));
  expect(ledger.claim("same-engine", identity, 72)).toBe("DUPLICATE_COMMAND");
  expect(ledger.claim("new-engine", { ...identity, engineSha: "f".repeat(40) }, 73)).toBe(
    "CLAIMED",
  );
  expect(ledger.complete({ ...identity, deliveryId: "new-engine", outcome: "retryable" })).toBe(
    "COMPLETION_REJECTED",
  );
  expect(
    ledger.complete({ ...identity, deliveryId: "legacy-delivery", outcome: "retryable" }),
  ).toBe("COMPLETION_IGNORED");
  expect(ledger.commandStatus("new-engine")).toBe("claimed");
  expect(ledger.hasComment("owner/repo", 71)).toBe(true);
  const db = new DatabaseSync(path);
  expect(
    db.prepare("SELECT command_key FROM deliveries WHERE id = ?").get("legacy-duplicate")
      ?.command_key,
  ).toBe(JSON.stringify(["owner/repo", 5, "a".repeat(40), "b".repeat(40), "e".repeat(40)]));
  db.close();
});
it.each(["claimed", "dispatched", "uncertain"])(
  "rejects binding active legacy %s claims",
  (status) => {
    const { ledger } = legacy(status);
    expect(() => ledger.bindLegacyCompletedEngine("legacy-delivery", "e".repeat(40))).toThrow(
      "LEGACY_ENGINE_BINDING_REJECTED",
    );
    expect(ledger.commandStatus("legacy-delivery")).toBe(status);
    expect(ledger.claim("new-engine", identity, 72)).toBe("DUPLICATE_COMMAND");
  },
);
it.each(["", "main", "E".repeat(40)])("rejects unverified legacy engine %j", (sha) => {
  const { ledger } = legacy();
  expect(() => ledger.bindLegacyCompletedEngine("legacy-delivery", sha)).toThrow(
    "LEGACY_ENGINE_BINDING_REJECTED",
  );
  expect(ledger.claim("new-engine", identity, 72)).toBe("DUPLICATE_COMMAND");
});
it("rejects missing and already-bound legacy claims without changing completed records", () => {
  const { ledger } = legacy();
  expect(() => ledger.bindLegacyCompletedEngine("missing", identity.engineSha)).toThrow(
    "LEGACY_ENGINE_BINDING_REJECTED",
  );
  ledger.bindLegacyCompletedEngine("legacy-delivery", identity.engineSha);
  expect(() => ledger.bindLegacyCompletedEngine("legacy-delivery", "f".repeat(40))).toThrow(
    "LEGACY_ENGINE_BINDING_REJECTED",
  );
  expect(ledger.claim("same-engine", identity, 72)).toBe("DUPLICATE_COMMAND");
});
it("rolls back legacy binding if the engine-specific key already exists", () => {
  const { ledger, path, key } = legacy();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO commands VALUES (?, ?, 'completed')").run(
    JSON.stringify(["owner/repo", 5, "a".repeat(40), "b".repeat(40), "e".repeat(40)]),
    "existing-engine",
  );
  expect(() => ledger.bindLegacyCompletedEngine("legacy-delivery", identity.engineSha)).toThrow(
    "LEGACY_ENGINE_BINDING_REJECTED",
  );
  expect(
    db.prepare("SELECT command_key FROM commands WHERE delivery_id = ?").get("legacy-delivery")
      ?.command_key,
  ).toBe(key);
  expect(
    db.prepare("SELECT command_key FROM deliveries WHERE id = ?").get("legacy-duplicate")
      ?.command_key,
  ).toBe(key);
  expect(ledger.commandStatus("existing-engine")).toBe("completed");
  db.close();
});
