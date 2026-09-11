import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isRepositoryRelativePath } from "../contracts/common.js";
import {
  assertCreatablePathContained,
  assertRealpathContained,
} from "../sandbox/path-containment.js";

interface TarHeader {
  name: string;
  type: string;
  linkname: string | null;
}
type TarExtractor = Writable & {
  on(
    event: "entry",
    listener: (header: TarHeader, entry: Readable, next: () => void) => void,
  ): TarExtractor;
};
const tar = createRequire(import.meta.url)("tar-stream") as { extract(): TarExtractor };

export async function extractSafeArchive(
  archive: Readable,
  destination: string,
): Promise<{ files: number }> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const extractor = tar.extract();
  let top: string | undefined;
  let files = 0;
  extractor.on("entry", (header, entry, next) => {
    void (async () => {
      const parts = header.name.split("/");
      const first = parts.shift();
      if (
        !isRepositoryRelativePath(header.name) ||
        !first ||
        first === "." ||
        parts.some((p) => p.toLowerCase() === ".git") ||
        first.toLowerCase() === ".git" ||
        (top !== undefined && first !== top) ||
        !["file", "directory", "symlink"].includes(header.type)
      )
        throw new Error("ARCHIVE_PATH_REJECTED");
      top = first;
      const relative = parts.join("/");
      if (!relative && header.type !== "directory") throw new Error("ARCHIVE_PATH_REJECTED");
      const path = await assertCreatablePathContained(destination, join(destination, relative));
      if (header.type === "directory") {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await assertRealpathContained(destination, path);
        entry.resume();
      } else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await assertRealpathContained(destination, dirname(path));
        if (header.type === "symlink") {
          await writeFile(path, `[AI_PR_REVIEW_SYMLINK]\ntarget: ${header.linkname ?? ""}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          entry.resume();
        } else {
          await pipeline(entry, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        }
        files++;
      }
      next();
    })().catch((error) =>
      extractor.destroy(error instanceof Error ? error : new Error("ARCHIVE_PATH_REJECTED")),
    );
  });
  await pipeline(archive, extractor);
  if (top === undefined) throw new Error("ARCHIVE_PATH_REJECTED");
  return { files };
}
