import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRepositoryRelativePath } from "../contracts/common.js";
import { unifiedDiffSections, type UnifiedDiffSection } from "../github/diff.js";
import { assertCreatablePathContained, assertRealpathContained } from "./path-containment.js";

function normalizeSelector(path: string, valid: (path: string) => boolean): string {
  // eslint-disable-next-line no-control-regex -- reject C0/C1 characters in repository selectors.
  if (!valid(path) || path.startsWith("-") || /[\x00-\x1f\x7f-\x9f]/.test(path))
    throw new Error("GIT_SHIM_REJECTED");
  const normalized = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (normalized === "." || !normalized) throw new Error("GIT_SHIM_REJECTED");
  return normalized;
}
function selectSections(diff: string, path: string, sections: UnifiedDiffSection[]): string {
  const requested = path;
  return sections
    .filter((section) =>
      [section.oldPath, section.path].some(
        (value) => value === requested || value.startsWith(requested + "/"),
      ),
    )
    .map((section) => diff.slice(section.start, section.end))
    .join("");
}
export function selectUnifiedDiffPath(unifiedDiff: string, requestedPath: string): string {
  return selectSections(
    unifiedDiff,
    normalizeSelector(requestedPath, isRepositoryRelativePath),
    unifiedDiffSections(unifiedDiff),
  );
}

export async function installGitDiffShim(reviewRoot: string, runtimeDir: string): Promise<string> {
  const root = resolve(reviewRoot);
  const runtime = resolve(runtimeDir);
  if (root === runtime || dirname(root) !== dirname(runtime))
    throw new Error("RUNTIME_MUST_BE_SIBLING");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const canonicalRuntime = await realpath(runtime);
  if (canonicalRoot === canonicalRuntime || dirname(canonicalRoot) !== dirname(canonicalRuntime))
    throw new Error("RUNTIME_MUST_BE_SIBLING");
  const diffPath = await assertRealpathContained(root, join(root, "diff/pr.diff"));
  await assertRealpathContained(root, join(root, "diff/numstat.txt"));
  const sections = unifiedDiffSections(await readFile(diffPath, "utf8"));
  const bin = await assertCreatablePathContained(runtime, join(runtime, "bin"));
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await assertRealpathContained(runtime, bin);
  const shim = join(bin, "git");
  const code = `#!${process.execPath}\n"use strict";
const {readFileSync,realpathSync}=require("node:fs");
const {join,relative,isAbsolute,sep}=require("node:path");
const root=${JSON.stringify(canonicalRoot)};
const sections=${JSON.stringify(sections)};
const isRepositoryRelativePath=${isRepositoryRelativePath.toString()};
const normalizeSelector=${normalizeSelector.toString()};
const selectSections=${selectSections.toString()};
function read(name) {
 const path=realpathSync.native(join(root,"diff",name)); const rel=relative(root,path);
 if(rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)) throw Error("GIT_SHIM_REJECTED");
 return readFileSync(path,"utf8");
}
try {
 if(process.env.AI_PR_REVIEW_ROOT && realpathSync.native(process.env.AI_PR_REVIEW_ROOT)!==root) throw Error("GIT_SHIM_REJECTED");
 const args=process.argv.slice(2);
 if(JSON.stringify(args)===JSON.stringify(["ls-files","--others","--exclude-standard"])) process.exit(0);
 const prefix=["diff","HEAD","-M","--no-color","--ignore-submodules=all"];
 if(!prefix.every((value,i)=>args[i]===value)) throw Error("GIT_SHIM_REJECTED");
 let output;
 if(args.length===5) output=read("pr.diff");
 else if(args.length===6 && args[5]==="--numstat") output=read("numstat.txt");
 else if(args.length===7 && args[5]==="--") output=selectSections(read("pr.diff"),normalizeSelector(args[6],isRepositoryRelativePath),sections);
 else throw Error("GIT_SHIM_REJECTED");
 process.stdout.write(output);
} catch { process.stderr.write("GIT_SHIM_REJECTED\\n"); process.exitCode=1; }
`;
  await writeFile(shim, code, { flag: "wx", mode: 0o755 });
  await chmod(shim, 0o755);
  return shim;
}
