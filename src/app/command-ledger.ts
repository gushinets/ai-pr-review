import { DatabaseSync } from "node:sqlite";

export interface CommandIdentity {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}
function commandKey(identity: CommandIdentity): string {
  return JSON.stringify([
    identity.repository.toLowerCase(),
    identity.prNumber,
    identity.baseSha.toLowerCase(),
    identity.headSha.toLowerCase(),
  ]);
}

/**
 * One durable volume is required. Claims never expire automatically: a crash or
 * dispatch timeout may have already started a billable run. The authenticated
 * terminal callback retains PASS/BLOCK snapshots and releases UNABLE/failed
 * commands for a NEW comment. Completed snapshots never become retryable.
 * Both signed comment IDs and delivery IDs survive release. Completion binds
 * the original delivery and exact snapshot, so old callbacks cannot release a
 * newer same-head command. For manual recovery, find the central run using its
 * delivery ID and reconcile the ORIGINAL delivery:
 * completed retains the snapshot; proven_not_dispatched releases only the
 * command, after independently confirming no queued/running/successful run.
 * Delivery replay records are retained in both cases. Recovery is operator-only;
 * never expose reconcile over HTTP or release a claim merely because it is old.
 */
export class SqliteCommandLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, command_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accepted_comments (
        repository TEXT NOT NULL, comment_id INTEGER NOT NULL,
        PRIMARY KEY(repository, comment_id)
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_key TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('claimed','dispatched','uncertain','completed'))
      );
    `);
  }
  close(): void {
    this.db.close();
  }
  hasDelivery(delivery: string): boolean {
    return this.db.prepare("SELECT 1 FROM deliveries WHERE id = ?").get(delivery) !== undefined;
  }
  hasComment(repository: string, commentId: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM accepted_comments WHERE repository = ? AND comment_id = ?")
        .get(repository.toLowerCase(), commentId) !== undefined
    );
  }
  claim(
    delivery: string,
    identity: CommandIdentity,
    commentId: number,
  ): "CLAIMED" | "DUPLICATE_DELIVERY" | "DUPLICATE_COMMENT" | "DUPLICATE_COMMAND" {
    if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new Error("COMMENT_ID_INVALID");
    const key = commandKey(identity);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT INTO deliveries (id, command_key) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .run(delivery, key);
      let result: "CLAIMED" | "DUPLICATE_DELIVERY" | "DUPLICATE_COMMENT" | "DUPLICATE_COMMAND" =
        "DUPLICATE_DELIVERY";
      if (inserted.changes !== 0) {
        const comment = this.db
          .prepare(
            "INSERT INTO accepted_comments (repository, comment_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          )
          .run(identity.repository.toLowerCase(), commentId);
        result =
          comment.changes === 0
            ? "DUPLICATE_COMMENT"
            : this.db
                  .prepare(
                    "INSERT INTO commands (command_key, delivery_id, status) VALUES (?, ?, 'claimed') ON CONFLICT DO NOTHING",
                  )
                  .run(key, delivery).changes !== 0
              ? "CLAIMED"
              : "DUPLICATE_COMMAND";
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recordDispatch(delivery: string, status: "dispatched" | "uncertain"): void {
    if (
      this.db
        .prepare("UPDATE commands SET status = ? WHERE delivery_id = ? AND status = 'claimed'")
        .run(status, delivery).changes !== 1
    )
      throw new Error("COMMAND_CLAIM_MISSING");
  }
  complete(
    completion: CommandIdentity & { deliveryId: string; outcome: "completed" | "retryable" },
  ): "COMPLETION_RECORDED" | "COMPLETION_IGNORED" | "COMPLETION_REJECTED" {
    const key = commandKey(completion);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const delivered = this.db
        .prepare("SELECT command_key FROM deliveries WHERE id = ?")
        .get(completion.deliveryId);
      const claimed = this.db
        .prepare("SELECT command_key, status FROM commands WHERE delivery_id = ?")
        .get(completion.deliveryId);
      let status: "COMPLETION_RECORDED" | "COMPLETION_IGNORED" | "COMPLETION_REJECTED";
      if (!delivered || delivered.command_key !== key || (claimed && claimed.command_key !== key))
        status = "COMPLETION_REJECTED";
      else if (!claimed || claimed.status === "completed") status = "COMPLETION_IGNORED";
      else {
        if (completion.outcome === "completed")
          this.db
            .prepare(
              "UPDATE commands SET status = 'completed' WHERE delivery_id = ? AND command_key = ?",
            )
            .run(completion.deliveryId, key);
        else
          this.db
            .prepare("DELETE FROM commands WHERE delivery_id = ? AND command_key = ?")
            .run(completion.deliveryId, key);
        status = "COMPLETION_RECORDED";
      }
      this.db.exec("COMMIT");
      return status;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reconcile(delivery: string, outcome: "completed" | "proven_not_dispatched"): void {
    const changed =
      outcome === "completed"
        ? this.db
            .prepare("UPDATE commands SET status = 'completed' WHERE delivery_id = ?")
            .run(delivery)
        : this.db
            .prepare("DELETE FROM commands WHERE delivery_id = ? AND status != 'completed'")
            .run(delivery);
    if (changed.changes !== 1) throw new Error("COMMAND_CLAIM_MISSING");
  }
}
