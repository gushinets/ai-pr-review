import { CENTRAL_CONFIG } from "../config/central-config.js";

export type ModelTelemetryRole = "reviewer_1" | "reviewer_2" | "reviewer_3" | "judge";
export type RuntimeModelTelemetryStatus = "running" | "completed" | "failed" | "cancelled";
export type PersistedModelTelemetryStatus =
  | "not_started"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface RuntimeModelTelemetry {
  role: ModelTelemetryRole;
  status: RuntimeModelTelemetryStatus;
  started_at_ms: number;
  duration_ms: number | null;
}

export interface PersistedModelTelemetry {
  role: ModelTelemetryRole;
  status: PersistedModelTelemetryStatus;
  duration_ms: number | null;
}

export const MODEL_TELEMETRY_PREFIX = "AI_PR_REVIEW_MODEL_TELEMETRY_V1 ";

const ROLE_ORDER: readonly ModelTelemetryRole[] = [
  "reviewer_1",
  "reviewer_2",
  "reviewer_3",
  "judge",
];

const expectedModels: Record<ModelTelemetryRole, string> = {
  reviewer_1: CENTRAL_CONFIG.reviewers[0].model,
  reviewer_2: CENTRAL_CONFIG.reviewers[1].model,
  reviewer_3: CENTRAL_CONFIG.reviewers[2].model,
  judge: CENTRAL_CONFIG.judge.model,
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function roleForKey(value: unknown): ModelTelemetryRole | null {
  if (value === "judge") return "judge";
  if (value === "panel-1") return "reviewer_1";
  if (value === "panel-2") return "reviewer_2";
  if (value === "panel-3") return "reviewer_3";
  return null;
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function extractModelTelemetry(value: unknown): RuntimeModelTelemetry[] {
  if (!record(value) || !record(value.details) || !Array.isArray(value.details.models)) return [];
  const found = new Map<ModelTelemetryRole, RuntimeModelTelemetry>();
  for (const raw of value.details.models) {
    if (!record(raw)) continue;
    const role = roleForKey(raw.roleKey);
    const started = safeTimestamp(raw.startedAt);
    if (role === null || started === null || raw.model !== expectedModels[role]) continue;
    let status: RuntimeModelTelemetryStatus;
    if (raw.status === "running") status = "running";
    else if (raw.status === "done") status = "completed";
    else if (raw.status === "error") status = "failed";
    else if (raw.status === "cancelled") status = "cancelled";
    else continue;
    const ended = safeTimestamp(raw.endedAt);
    found.set(role, {
      role,
      status,
      started_at_ms: started,
      duration_ms: ended === null ? null : Math.max(0, ended - started),
    });
  }
  return ROLE_ORDER.flatMap((role) => {
    const value = found.get(role);
    return value === undefined ? [] : [value];
  });
}

export function parseRuntimeModelTelemetry(value: unknown): RuntimeModelTelemetry[] | null {
  if (!Array.isArray(value)) return null;
  const found = new Map<ModelTelemetryRole, RuntimeModelTelemetry>();
  for (const raw of value) {
    if (!record(raw)) return null;
    const keys = ["role", "status", "started_at_ms", "duration_ms"];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key)))
      return null;
    const role = ROLE_ORDER.includes(raw.role as ModelTelemetryRole)
      ? (raw.role as ModelTelemetryRole)
      : null;
    const started = safeTimestamp(raw.started_at_ms);
    const duration = raw.duration_ms === null ? null : safeTimestamp(raw.duration_ms);
    if (
      role === null ||
      started === null ||
      !["running", "completed", "failed", "cancelled"].includes(String(raw.status)) ||
      (raw.duration_ms !== null && duration === null) ||
      found.has(role)
    )
      return null;
    found.set(role, {
      role,
      status: raw.status as RuntimeModelTelemetryStatus,
      started_at_ms: started,
      duration_ms: duration,
    });
  }
  return ROLE_ORDER.flatMap((role) => {
    const entry = found.get(role);
    return entry === undefined ? [] : [entry];
  });
}

export function emptyPersistedModelTelemetry(): PersistedModelTelemetry[] {
  return ROLE_ORDER.map((role) => ({ role, status: "not_started", duration_ms: null }));
}

export function finalizeRuntimeModelTelemetry(
  entries: readonly RuntimeModelTelemetry[],
  cause: "completed" | "deadline" | "cancelled" | "failed",
  now: number,
): PersistedModelTelemetry[] {
  return entries.map((entry) => {
    if (entry.status !== "running")
      return { role: entry.role, status: entry.status, duration_ms: entry.duration_ms };
    return {
      role: entry.role,
      status:
        cause === "deadline"
          ? "timed_out"
          : cause === "cancelled"
            ? "cancelled"
            : cause === "completed"
              ? "failed"
              : "failed",
      duration_ms: Math.max(0, now - entry.started_at_ms),
    };
  });
}

export function mergePersistedModelTelemetry(
  accumulated: readonly PersistedModelTelemetry[],
  current: readonly PersistedModelTelemetry[],
): PersistedModelTelemetry[] {
  const byRole = new Map(accumulated.map((entry) => [entry.role, { ...entry }]));
  for (const next of current) {
    const previous = byRole.get(next.role) ?? {
      role: next.role,
      status: "not_started" as const,
      duration_ms: null,
    };
    if (next.status === "not_started") continue;
    byRole.set(next.role, {
      role: next.role,
      status: next.status,
      duration_ms:
        next.duration_ms === null
          ? previous.duration_ms
          : (previous.duration_ms ?? 0) + next.duration_ms,
    });
  }
  return ROLE_ORDER.map(
    (role) => byRole.get(role) ?? { role, status: "not_started", duration_ms: null },
  );
}
