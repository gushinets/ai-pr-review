import { describe, expect, it } from "vitest";
import { buildDiffIndex, loadPrDiff } from "../../src/github/diff.js";
import type { GithubReadClient } from "../../src/github/github-client.js";

const head = "a".repeat(40);
const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,2 +10,3 @@",
  " old",
  "-removed",
  "+added",
  "+added2",
].join("\n");
function reader(overrides: Partial<GithubReadClient> = {}): GithubReadClient {
  return {
    getPullRequest: async () => ({
      number: 7,
      state: "open",
      repository: "o/r",
      author: "bot",
      title: "x",
      body: null,
      baseBranch: "main",
      baseSha: "b".repeat(40),
      headSha: head,
      changedFiles: 1,
      additions: 2,
      deletions: 1,
    }),
    getPullRequestDiff: async () => patch,
    listChangedFiles: async () => [
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
    ],
    ...overrides,
  } as GithubReadClient;
}

describe("diff anchors", () => {
  it("indexes only represented old/new lines", () => {
    const index = buildDiffIndex(patch);
    for (const location of [
      { path: "src/a.ts", line: 10, side: "LEFT" },
      { path: "src/a.ts", line: 10, side: "RIGHT" },
      { path: "src/a.ts", line: 11, side: "LEFT" },
      { path: "src/a.ts", line: 11, side: "RIGHT" },
      { path: "src/a.ts", line: 12, side: "RIGHT" },
    ] as const)
      expect(index.contains(location)).toBe(true);
    for (const location of [
      { path: "src/a.ts", line: 12, side: "LEFT" },
      { path: "src/a.ts", line: 99, side: "RIGHT" },
      { path: "else.ts", line: 11, side: "RIGHT" },
      { path: "../src/a.ts", line: 11, side: "RIGHT" },
    ] as const)
      expect(index.contains(location)).toBe(false);
  });
  it("uses the current rename path on both sides and supports multiple hunks", () => {
    const index = buildDiffIndex(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 70%",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "@@ -8 +8 @@ label",
        " context",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect(index.contains({ path: "new.ts", line: 1, side: "LEFT" })).toBe(true);
    expect(index.contains({ path: "old.ts", line: 1, side: "LEFT" })).toBe(false);
    expect(index.contains({ path: "new.ts", line: 8, side: "RIGHT" })).toBe(true);
    expect(index.contains({ path: "new.ts", line: 4, side: "RIGHT" })).toBe(false);
  });
  it("supports additions, deletions, binary and pure rename without inventing anchors", () => {
    const index = buildDiffIndex(
      [
        "diff --git a/new b/new",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new",
        "@@ -0,0 +1 @@",
        "+new",
        "diff --git a/gone b/gone",
        "deleted file mode 100644",
        "--- a/gone",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "diff --git a/a.bin b/a.bin",
        "index 123..456 100644",
        "Binary files a/a.bin and b/a.bin differ",
        "diff --git a/old b/renamed",
        "similarity index 100%",
        "rename from old",
        "rename to renamed",
      ].join("\n"),
    );
    expect(index.contains({ path: "new", line: 1, side: "RIGHT" })).toBe(true);
    expect(index.contains({ path: "new", line: 1, side: "LEFT" })).toBe(false);
    expect(index.contains({ path: "gone", line: 1, side: "LEFT" })).toBe(true);
    expect(index.contains({ path: "gone", line: 1, side: "RIGHT" })).toBe(false);
    expect(index.contains({ path: "renamed", line: 1, side: "RIGHT" })).toBe(false);
  });
  it("decodes Git quoted UTF-8 paths and normalizes relative POSIX paths", () => {
    const index = buildDiffIndex(
      'diff --git "a/\\303\\251 space.ts" "b/\\303\\251 space.ts"\n--- "a/\\303\\251 space.ts"\n+++ "b/\\303\\251 space.ts"\n@@ -1 +1 @@\n-x\n+y\n',
    );
    expect(index.contains({ path: "é space.ts", line: 1, side: "RIGHT" })).toBe(true);
    const normalized = buildDiffIndex(patch.replaceAll("src/a.ts", "./src/a.ts"));
    expect(normalized.contains({ path: "src/a.ts", line: 11, side: "RIGHT" })).toBe(true);
  });
  it.each(["/etc/passwd", "../outside", "src/../outside", "C:/secret", "bad\0file", "bad\\file"])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => buildDiffIndex(patch.replaceAll("src/a.ts", path))).toThrow();
    },
  );
  it.each([
    patch.replace("-10,2", "-0,2"),
    patch.replace("-10,2", "-9007199254740992,2"),
    patch.replace("-10,2", "--1,2"),
    patch.replace("+10,3", "+10,4"),
    patch + "\n+overflow",
    patch + "\n@@ -10 +10 @@\n same",
    patch.replace("--- a/src/a.ts", "--- a/other.ts"),
    patch.replace("+++ b/src/a.ts\n", ""),
    "@@ -1 +1 @@\n-x\n+y",
    "garbage",
    patch + "\ninvalid",
  ])("rejects malformed or truncated diff %#", (diff) =>
    expect(() => buildDiffIndex(diff)).toThrow(),
  );
});

describe("exact-head diff loading", () => {
  it("fetches the requested PR and validates metadata before returning anchors", async () => {
    const calls: string[] = [];
    const github = reader();
    const get = github.getPullRequest;
    github.getPullRequest = async (repo, number) => {
      calls.push(`${repo}:${number}`);
      return get(repo, number);
    };
    const result = await loadPrDiff(github, "o/r", 7, head);
    expect(result.unifiedDiff).toBe(patch);
    expect(result.index.contains({ path: "src/a.ts", line: 12, side: "RIGHT" })).toBe(true);
    expect(calls).toEqual(["o/r:7", "o/r:7"]);
  });
  it.each(["headSha", "baseSha"] as const)(
    "signals stale when %s changes during reads",
    async (field) => {
      const github = reader();
      const get = github.getPullRequest;
      let reads = 0;
      github.getPullRequest = async (repo, number) => ({
        ...(await get(repo, number)),
        ...(++reads === 2 ? { [field]: "c".repeat(40) } : {}),
      });
      await expect(loadPrDiff(github, "o/r", 7, head)).rejects.toMatchObject({
        status: "STALE_SKIPPED",
      });
    },
  );
  it("signals an already changed head before fetching mutable evidence", async () => {
    const github = reader({
      getPullRequestDiff: async () => {
        throw new Error("must not fetch");
      },
    });
    await expect(loadPrDiff(github, "o/r", 7, "c".repeat(40))).rejects.toMatchObject({
      status: "STALE_SKIPPED",
    });
  });
  it.each([
    { listChangedFiles: async () => [] },
    {
      listChangedFiles: async () => [
        { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      ],
    },
    {
      listChangedFiles: async () => [
        { filename: "wrong.ts", status: "modified", additions: 2, deletions: 1 },
      ],
    },
    { getPullRequestDiff: async () => patch.replace("+added2", "") },
  ])("fails closed on inconsistent file/line metadata %#", async (override) => {
    await expect(loadPrDiff(reader(override), "o/r", 7, head)).rejects.toMatchObject({
      reason: "SNAPSHOT_FAILED",
    });
  });
  it("enforces pre-model size ceilings again", async () => {
    const github = reader();
    const get = github.getPullRequest;
    github.getPullRequest = async (repo, number) => ({
      ...(await get(repo, number)),
      additions: 20_000,
    });
    await expect(loadPrDiff(github, "o/r", 7, head)).rejects.toMatchObject({
      reason: "PR_TOO_LARGE",
    });
  });
});

describe("strict diff section boundaries", () => {
  it("accepts Git's trailing tab delimiter on space-containing file headers", () => {
    const spaced = patch
      .replaceAll("src/a.ts", "space name.ts")
      .replace("--- a/space name.ts", "--- a/space name.ts\t")
      .replace("+++ b/space name.ts", "+++ b/space name.ts\t");
    expect(
      buildDiffIndex(spaced).contains({ path: "space name.ts", line: 11, side: "RIGHT" }),
    ).toBe(true);
  });
  it.each([
    "diff --git a/a b/a\n--- a/a",
    "diff --git a/a b/a\n--- a/a\n+++ b/a",
    "diff --git a/a b/a\nrename from a",
    patch + "\n\\ No newline at end of file\n\\ No newline at end of file",
  ])("rejects unfinished sections or duplicated newline markers %#", (diff) =>
    expect(() => buildDiffIndex(diff)).toThrow(),
  );
  it("accepts an empty new file and mode-only changes without inventing lines", () => {
    const index = buildDiffIndex(
      "diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\ndiff --git a/mode b/mode\nold mode 100644\nnew mode 100755\n",
    );
    expect(index.contains({ path: "empty", line: 1, side: "RIGHT" })).toBe(false);
    expect(index.contains({ path: "mode", line: 1, side: "LEFT" })).toBe(false);
  });
});

describe("normalized diff metadata", () => {
  it("rejects duplicate normalized filenames that could hide a different changed file", async () => {
    const second = patch.replaceAll("src/a.ts", "src/b.ts");
    const github = reader({
      getPullRequestDiff: async () => `${patch}\n${second}`,
      listChangedFiles: async () =>
        ["src/a.ts", "./src/a.ts"].map((filename) => ({
          filename,
          status: "modified",
          additions: 2,
          deletions: 1,
        })),
    });
    const get = github.getPullRequest;
    github.getPullRequest = async (repo, number) => ({
      ...(await get(repo, number)),
      changedFiles: 2,
      additions: 4,
      deletions: 2,
    });
    await expect(loadPrDiff(github, "o/r", 7, head)).rejects.toMatchObject({
      reason: "SNAPSHOT_FAILED",
    });
  });
});

describe("unquoted filenames containing the diff separator", () => {
  it("loads exact-head metadata and anchors for dir b/name.ts", async () => {
    const github = reader({
      getPullRequestDiff: async () => patch.replaceAll("src/a.ts", "dir b/name.ts"),
      listChangedFiles: async () => [
        { filename: "dir b/name.ts", status: "modified", additions: 2, deletions: 1 },
      ],
    });
    const { index } = await loadPrDiff(github, "o/r", 7, head);
    expect(index.contains({ path: "dir b/name.ts", line: 11, side: "LEFT" })).toBe(true);
    expect(index.contains({ path: "dir b/name.ts", line: 12, side: "RIGHT" })).toBe(true);
    expect(index.contains({ path: "name.ts", line: 12, side: "RIGHT" })).toBe(false);
  });
  it.each([
    { header: "--- /dev/null\n+++ b/dir b/name.ts\t\n@@ -0,0 +1 @@\n+new", side: "RIGHT" },
    { header: "--- a/dir b/name.ts\t\n+++ /dev/null\n@@ -1 +0,0 @@\n-old", side: "LEFT" },
  ] as const)("uses the non-null file header for $side-only changes", ({ header, side }) => {
    const index = buildDiffIndex(`diff --git a/dir b/name.ts b/dir b/name.ts\n${header}`);
    expect(index.contains({ path: "dir b/name.ts", line: 1, side })).toBe(true);
    expect(index.contains({ path: "name.ts", line: 1, side })).toBe(false);
  });
  it("uses rename headers and the current path for both sides of a changed rename", () => {
    const index = buildDiffIndex(
      "diff --git a/old b/name.ts b/new b/name.ts\nrename from old b/name.ts\nrename to new b/name.ts\n--- a/old b/name.ts\t\n+++ b/new b/name.ts\t\n@@ -1 +1 @@\n-old\n+new",
    );
    expect(index.contains({ path: "new b/name.ts", line: 1, side: "LEFT" })).toBe(true);
    expect(index.contains({ path: "new b/name.ts", line: 1, side: "RIGHT" })).toBe(true);
    expect(index.contains({ path: "old b/name.ts", line: 1, side: "LEFT" })).toBe(false);
  });
  it("resolves a pure rename from its rename headers", () => {
    const index = buildDiffIndex(
      "diff --git a/old b/name.ts b/new b/name.ts\nsimilarity index 100%\nrename from old b/name.ts\nrename to new b/name.ts",
    );
    expect(index.contains({ path: "new b/name.ts", line: 1, side: "RIGHT" })).toBe(false);
  });
  it("matches mode-only metadata when no separate file headers exist", async () => {
    const github = reader({
      getPullRequestDiff: async () =>
        "diff --git a/dir b/name.ts b/dir b/name.ts\nold mode 100644\nnew mode 100755",
      listChangedFiles: async () => [
        { filename: "dir b/name.ts", status: "modified", additions: 0, deletions: 0 },
      ],
    });
    const get = github.getPullRequest;
    github.getPullRequest = async (repo, number) => ({
      ...(await get(repo, number)),
      additions: 0,
      deletions: 0,
    });
    const { index } = await loadPrDiff(github, "o/r", 7, head);
    expect(index.contains({ path: "dir b/name.ts", line: 1, side: "RIGHT" })).toBe(false);
  });
  it.each([
    "diff --git a/other b/name.ts b/dir b/name.ts\n--- a/dir b/name.ts\n+++ b/dir b/name.ts\n@@ -1 +1 @@\n-old\n+new",
    "diff --git a/old b/name.ts b/new b/name.ts\nrename from old b/name.ts\nrename to other b/name.ts",
    "diff --git a/dir b/../name.ts b/dir b/../name.ts\n--- a/dir b/../name.ts\n+++ b/dir b/../name.ts\n@@ -1 +1 @@\n-old\n+new",
  ])("still rejects conflicting or unsafe paths %#", (diff) =>
    expect(() => buildDiffIndex(diff)).toThrow(),
  );
});
