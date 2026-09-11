import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { extractSafeArchive } from "../../src/github/archive.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function destination() {
  const p = await mkdtemp(join(tmpdir(), "archive-test-"));
  temps.push(p);
  return p;
}
function fixture(name: string) {
  return createReadStream(new URL(`../../fixtures/security/archive-${name}.tar`, import.meta.url));
}
it("extracts one generated archive root into ordinary nonexecutable files", async () => {
  const root = await destination();
  expect(await extractSafeArchive(fixture("normal"), root)).toEqual({ files: 1 });
  expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("source\n");
  expect((await lstat(join(root, "src/a.ts"))).isFile()).toBe(true);
});
it.each([
  "dotdot",
  "absolute",
  "nul",
  "hardlink",
  "device",
  "fifo",
  "git",
  "roots",
  "socket",
  "unknown",
  "block_device",
])("rejects actual malicious tar: %s", async (name) => {
  await expect(extractSafeArchive(fixture(name), await destination())).rejects.toThrow(
    "ARCHIVE_PATH_REJECTED",
  );
});
it.each([
  ["relative_link", "../outside"],
  ["absolute_link", "/etc/passwd"],
])("materializes %s as inert text", async (name, target) => {
  const root = await destination();
  await extractSafeArchive(fixture(name!), root);
  expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(root, "link"), "utf8")).toBe(
    `[AI_PR_REVIEW_SYMLINK]\ntarget: ${target}\n`,
  );
});
it("rejects a real preexisting parent symlink without modifying its outside canary", async () => {
  const privateDir = await destination();
  const root = join(privateDir, "target");
  const outside = join(privateDir, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "a.ts"), "CANARY");
  await symlink(outside, join(root, "src"), "junction");
  await expect(extractSafeArchive(fixture("normal"), root)).rejects.toThrow();
  expect(await readFile(join(outside, "a.ts"), "utf8")).toBe("CANARY");
});
it("streams the exact immutable HEAD tarball through pinned Octokit and gunzip", async () => {
  const { Octokit } = await import("@octokit/rest");
  const { gzipSync } = await import("node:zlib");
  const { createGitHubClient } = await import("../../src/github/github-client.js");
  const head = "a".repeat(40);
  const urls: string[] = [];
  const github = createGitHubClient(
    new Octokit({
      request: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          urls.push(String(input));
          expect(init?.method).toBe("GET");
          return new Response(
            gzipSync(
              await readFile(
                new URL("../../fixtures/security/archive-normal.tar", import.meta.url),
              ),
            ),
            { headers: { "content-type": "application/x-gzip" } },
          );
        },
      },
    }),
  );
  const root = await destination();
  await extractSafeArchive(await github.downloadHeadArchive("o/r", head), root);
  expect(urls).toEqual([`https://api.github.com/repos/o/r/tarball/${head}`]);
  expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("source\n");
  await expect(github.downloadHeadArchive("o/r", "HEAD")).rejects.toThrow();
  expect(urls).toHaveLength(1);
});
it("rejects a truncated real tar stream without returning a usable snapshot", async () => {
  const { Readable } = await import("node:stream");
  const tar = await readFile(
    new URL("../../fixtures/security/archive-normal.tar", import.meta.url),
  );
  await expect(
    extractSafeArchive(Readable.from(tar.subarray(0, 1538)), await destination()),
  ).rejects.toThrow();
});
