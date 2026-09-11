import { ReadableStream } from "node:stream/web";
import { crc32, inflateRawSync } from "node:zlib";
import type { Octokit } from "@octokit/rest";
import { unzipSync } from "fflate";
import { validateReviewIdentity, type ReviewIdentityV1 } from "../contracts/review-identity.js";
import type { ReviewStateV1 } from "../contracts/review-state.js";
import { retryRead } from "../github/github-client.js";
import { artifactName, STATE_FILE_NAME } from "./artifact-name.js";
import { parseReviewState } from "./review-state.js";

const CENTRAL_WORKFLOW = "gushinets/ai-pr-review/.github/workflows/reusable-ai-pr-review.yml";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
type Artifact = Awaited<
  ReturnType<Octokit["rest"]["actions"]["listArtifactsForRepo"]>
>["data"]["artifacts"][number];
export type StateDiscovery =
  | { kind: "reuse"; state: ReviewStateV1 }
  | {
      kind: "fresh";
      previous: ReviewStateV1 | null;
      history: ReviewStateV1[];
      rerunnable: ReviewStateV1 | null;
    };

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error.status === 404 || error.status === 410)
  );
}

async function readZip(stream: unknown): Promise<Uint8Array> {
  if (!(stream instanceof ReadableStream)) throw new Error("STATE_LOAD_FAILED");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || (length += value.byteLength) > MAX_STATE_BYTES)
        throw new Error("STATE_LOAD_FAILED");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function parseZip(bytes: Uint8Array): ReviewStateV1 {
  // Canonical artifacts are small, single-file ZIP32 archives. Never write their paths to disk.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && view.getUint32(end, true) !== 0x06054b50)
    end--;
  if (
    end < 0 ||
    view.getUint32(end, true) !== 0x06054b50 ||
    end + 22 + view.getUint16(end + 20, true) !== bytes.length ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== 1 ||
    view.getUint16(end + 10, true) !== 1
  )
    throw new Error("STATE_LOAD_FAILED");
  const directory = view.getUint32(end + 16, true);
  if (
    directory + view.getUint32(end + 12, true) !== end ||
    view.getUint32(directory, true) !== 0x02014b50
  )
    throw new Error("STATE_LOAD_FAILED");
  const flags = view.getUint16(directory + 8, true);
  const method = view.getUint16(directory + 10, true);
  const nameLength = view.getUint16(directory + 28, true);
  const mode = (view.getUint32(directory + 38, true) >>> 16) & 0xf000;
  const decode = new TextDecoder("utf-8", { fatal: true });
  if (
    flags & ~0x0808 ||
    (mode !== 0 && mode !== 0x8000) ||
    (method !== 0 && method !== 8) ||
    directory +
      46 +
      nameLength +
      view.getUint16(directory + 30, true) +
      view.getUint16(directory + 32, true) !==
      end ||
    view.getUint16(directory + 34, true) !== 0 ||
    view.getUint32(directory + 42, true) !== 0 ||
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== flags ||
    view.getUint16(8, true) !== method ||
    decode.decode(bytes.subarray(directory + 46, directory + 46 + nameLength)) !==
      STATE_FILE_NAME ||
    decode.decode(bytes.subarray(30, 30 + view.getUint16(26, true))) !== STATE_FILE_NAME ||
    30 +
      view.getUint16(26, true) +
      view.getUint16(28, true) +
      view.getUint32(directory + 20, true) >
      directory
  )
    throw new Error("STATE_LOAD_FAILED");
  const dataEnd =
    30 + view.getUint16(26, true) + view.getUint16(28, true) + view.getUint32(directory + 20, true);
  const metadata =
    flags & 8 ? dataEnd + (view.getUint32(dataEnd, true) === 0x08074b50 ? 4 : 0) : 14;
  if (
    (flags & 8 ? metadata + 12 : dataEnd) !== directory ||
    view.getUint32(metadata, true) !== view.getUint32(directory + 16, true) ||
    view.getUint32(metadata + 4, true) !== view.getUint32(directory + 20, true) ||
    view.getUint32(metadata + 8, true) !== view.getUint32(directory + 24, true)
  )
    throw new Error("STATE_LOAD_FAILED");
  const originalSize = view.getUint32(directory + 24, true);
  if (originalSize > MAX_STATE_BYTES) throw new Error("STATE_LOAD_FAILED");
  if (method === 8) {
    const compressed = bytes.subarray(
      30 + view.getUint16(26, true) + view.getUint16(28, true),
      dataEnd,
    );
    // fflate trusts the ZIP size and may truncate output. Bound and verify actual inflation first.
    // The pinned Node typings omit the documented info:true return shape.
    const inflated = inflateRawSync(compressed, {
      maxOutputLength: MAX_STATE_BYTES,
      info: true,
    }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (
      inflated.buffer.length !== originalSize ||
      inflated.engine.bytesWritten !== compressed.length
    )
      throw new Error("STATE_LOAD_FAILED");
  }
  const files = unzipSync(bytes, {
    filter(file) {
      if (file.name !== STATE_FILE_NAME || file.originalSize > MAX_STATE_BYTES)
        throw new Error("STATE_LOAD_FAILED");
      return true;
    },
  });
  const content = files[STATE_FILE_NAME];
  if (
    !content ||
    content.length !== view.getUint32(directory + 24, true) ||
    crc32(content) !== view.getUint32(directory + 16, true)
  )
    throw new Error("STATE_LOAD_FAILED");
  return parseReviewState(decode.decode(content));
}

export class GitHubArtifactStateStore {
  // defaultBranch comes from trusted GitHub repository metadata, never PR configuration.
  constructor(
    private readonly octokit: Octokit,
    private readonly trusted: { defaultBranch: string },
  ) {}

  async load(identity: ReviewIdentityV1, baseBranch: string): Promise<StateDiscovery> {
    try {
      if (
        !validateReviewIdentity(identity).ok ||
        !baseBranch ||
        !this.trusted.defaultBranch ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)
      )
        throw new Error("STATE_LOAD_FAILED");
      const [owner, repo] = identity.repository.split("/") as [string, string];
      const name = artifactName(identity.pr_number);
      const artifacts: Artifact[] = [];
      let total: number | undefined;
      for (let page = 1; ; page++) {
        const { data } = await retryRead(() =>
          this.octokit.rest.actions.listArtifactsForRepo({
            owner,
            repo,
            name,
            per_page: 100,
            page,
          }),
        );
        if (total !== undefined && total !== data.total_count) throw new Error("STATE_LOAD_FAILED");
        total = data.total_count;
        artifacts.push(...data.artifacts);
        if (
          !Number.isSafeInteger(total) ||
          total < artifacts.length ||
          (artifacts.length < total && data.artifacts.length < 100)
        )
          throw new Error("STATE_LOAD_FAILED");
        if (artifacts.length === total) break;
      }
      let previous: ReviewStateV1 | null = null;
      const history: ReviewStateV1[] = [];
      let rerunnable: ReviewStateV1 | null = null;
      const candidates = artifacts.filter(
        (artifact) => artifact.name === name && !artifact.expired && artifact.workflow_run,
      );
      if (
        candidates.some(
          (artifact) =>
            artifact.created_at === null || !Number.isFinite(Date.parse(artifact.created_at)),
        )
      )
        throw new Error("STATE_LOAD_FAILED");
      for (const artifact of candidates.sort(
        (a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!) || b.id - a.id,
      )) {
        const runId = artifact.workflow_run!.id;
        if (typeof runId !== "number" || !Number.isSafeInteger(runId) || runId < 1)
          throw new Error("STATE_LOAD_FAILED");
        let state: ReviewStateV1;
        try {
          const { data: run } = await retryRead(() =>
            this.octokit.rest.actions.getWorkflowRun({
              owner,
              repo,
              run_id: runId,
            }),
          );
          if (
            run.id !== runId ||
            run.repository.full_name !== identity.repository ||
            run.path !== ".github/workflows/ai-pr-review.yml" ||
            run.head_branch !== this.trusted.defaultBranch ||
            (run.event !== "workflow_run" && run.event !== "workflow_dispatch")
          )
            continue;
          const references = (run.referenced_workflows ?? []).filter((reference) =>
            reference.path.startsWith(`${CENTRAL_WORKFLOW}@`),
          );
          if (references.length !== 1) continue;
          const reference = references[0]!;
          const pin = reference.path.slice(CENTRAL_WORKFLOW.length + 1);
          if (!/^[0-9a-f]{40}$/i.test(pin) || reference.sha !== pin) continue;
          const { data } = await retryRead(() =>
            this.octokit.rest.actions.downloadArtifact({
              owner,
              repo,
              artifact_id: artifact.id,
              archive_format: "zip",
              request: { parseSuccessResponseBody: false },
            }),
          );
          state = parseZip(await readZip(data));
          if (state.attempt_identity.engine_sha !== pin) throw new Error("STATE_LOAD_FAILED");
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        const saved = state.review_identity;
        if (
          !saved ||
          saved.repository !== identity.repository ||
          saved.pr_number !== identity.pr_number ||
          state.lineage.base_branch !== baseBranch ||
          state.lineage.linear_issue !== identity.linear_issue
        )
          continue;
        const same = (Object.keys(identity) as (keyof ReviewIdentityV1)[]).every(
          (key) => saved[key] === identity[key],
        );
        if (state.outcome !== "UNABLE_TO_REVIEW") {
          if (same) return { kind: "reuse", state };
          previous ??= state;
          history.push(state);
        } else if (same) rerunnable ??= state;
      }
      return { kind: "fresh", previous, history, rerunnable };
    } catch {
      // A retained trusted artifact might be the current verdict; never silently reroll it.
      throw new Error("STATE_LOAD_FAILED");
    }
  }
}
