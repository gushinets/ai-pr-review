import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The SDK never downloads. Resolve only the pinned, build-time installed platform bundle.
const require = createRequire(import.meta.url);
export const VERSION = "1.6.1";

export async function collectGraph(targetRoot, request) {
  const pkg = require("@colbymchenry/codegraph/package.json");
  if (pkg.version !== VERSION) throw new Error("VERSION_MISMATCH");
  const { CodeGraph } = require("@colbymchenry/codegraph");
  const library = dirname(
    require.resolve(
      `@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist/index.js`,
    ),
  );
  const { isTestPath } = require(join(library, "search/query-utils.js"));
  const { scanDynamicDispatch } = require(join(library, "mcp/dynamic-boundaries.js"));
  const bounds = request.bounds;
  const cg = await CodeGraph.init(targetRoot);
  let truncated = false;
  const nodes = new Map(),
    edges = new Map(),
    changed = new Set(),
    impacted = new Set();
  const dependants = [],
    affected = new Set(),
    tests = new Set(),
    boundaries = [];
  const addNode = (node) => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= bounds.symbols) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  const addEdge = (edge) => {
    const key = `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.line ?? ""}`;
    if (edges.has(key)) return;
    if (edges.size >= bounds.edges) {
      truncated = true;
      return;
    }
    if (nodes.has(edge.source) && nodes.has(edge.target)) edges.set(key, edge);
    else truncated = true;
  };
  const addBoundary = (boundary) => {
    if (boundaries.length >= bounds.boundaries) {
      truncated = true;
      return;
    }
    boundaries.push(boundary);
  };
  try {
    const result = await cg.indexAll();
    if (!result.success || cg.getIndexState() !== "complete") throw new Error("INDEX_FAILED");
    for (const file of request.changedFiles) {
      if (file.status === "removed") continue;
      const fileNodes = cg.getNodesInFile(file.filename);
      const ranges = request.ranges[file.filename];
      for (const node of fileNodes) {
        if (["file", "import", "export", "parameter"].includes(node.kind)) continue;
        if (
          ranges?.length &&
          !ranges.some(([start, end]) => node.startLine <= end && node.endLine >= start)
        )
          continue;
        if (addNode(node)) changed.add(node.id);
      }
      if (!fileNodes.length)
        addBoundary({
          file: file.filename,
          line: null,
          kind: "not_indexed",
          symbol_id: null,
          reference: null,
        });
    }
    for (const id of changed) {
      // Bounded SDK traversals retain real parser/resolver edges and their confidence.
      const incoming = cg.traverse(id, {
        maxDepth: bounds.depth,
        limit: bounds.symbols,
        direction: "incoming",
        edgeKinds: [
          "calls",
          "references",
          "imports",
          "extends",
          "implements",
          "type_of",
          "instantiates",
          "overrides",
        ],
        includeStart: true,
      });
      if (incoming.nodes.size >= bounds.symbols) truncated = true;
      for (const node of incoming.nodes.values()) if (addNode(node)) impacted.add(node.id);
      for (const edge of incoming.edges) addEdge(edge);
      const outgoing = cg.traverse(id, {
        maxDepth: 1,
        limit: bounds.symbols,
        direction: "outgoing",
        edgeKinds: ["calls", "references", "imports", "instantiates"],
        includeStart: true,
      });
      if (outgoing.nodes.size >= bounds.symbols) truncated = true;
      for (const node of outgoing.nodes.values()) addNode(node);
      for (const edge of outgoing.edges) addEdge(edge);
    }
    const queue = request.changedFiles
      .filter((f) => f.status !== "removed")
      .map((f) => ({ file: f.filename, depth: 0 }));
    const seen = new Set(queue.map((item) => item.file));
    for (const item of queue) {
      affected.add(item.file);
      if (isTestPath(item.file)) tests.add(item.file);
    }
    // Same static getFileDependents + test classifier as CodeGraph's affected CLI.
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      if (item.depth >= bounds.depth) {
        if (cg.getFileDependents(item.file).length) truncated = true;
        continue;
      }
      for (const dependant of cg.getFileDependents(item.file)) {
        if (dependants.length >= bounds.edges || seen.size >= bounds.files) {
          truncated = true;
          break;
        }
        dependants.push({ file: item.file, dependant, depth: item.depth + 1 });
        affected.add(dependant);
        if (isTestPath(dependant)) tests.add(dependant);
        if (!seen.has(dependant)) {
          seen.add(dependant);
          queue.push({ file: dependant, depth: item.depth + 1 });
        }
      }
    }
    for (const node of nodes.values()) {
      affected.add(node.filePath);
      for (const reference of cg.getUnresolvedReferencesFrom(node.id)) {
        addBoundary({
          file: node.filePath,
          line: reference.line,
          kind: "unresolved_reference",
          symbol_id: node.id,
          reference: reference.referenceName,
        });
      }
    }
    const dynamicSites = new Set();
    for (const node of nodes.values()) {
      if (boundaries.length >= bounds.boundaries) {
        truncated = true;
        break;
      }
      const body = await cg.getCode(node.id);
      if (body === null) {
        truncated = true;
        continue;
      }
      // Pinned 1.6.1 detector caps each body at 60k chars and three forms. Surface these limits.
      if (body.length > bounds.dynamic_body_chars) truncated = true;
      const sites = scanDynamicDispatch(
        body.slice(0, bounds.dynamic_body_chars),
        node.language,
        node.startLine,
      );
      if (sites.length >= bounds.dynamic_sites_per_symbol) truncated = true;
      for (const site of sites) {
        const key = `${node.filePath}:${site.line}:${site.form}`;
        if (dynamicSites.has(key)) continue;
        dynamicSites.add(key);
        // Do not copy source snippets or turn plausible runtime candidates into graph edges.
        addBoundary({
          file: node.filePath,
          line: site.line,
          kind: "dynamic_dispatch",
          symbol_id: node.id,
          reference: site.form,
        });
      }
    }
    const output = {
      version: VERSION,
      truncated,
      symbols: [...nodes.values()].map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        file: node.filePath,
        start_line: node.startLine,
        end_line: node.endLine,
      })),
      edges: [...edges.values()].map((edge) => ({
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        line: edge.line ?? null,
        confidence: typeof edge.metadata?.confidence === "number" ? edge.metadata.confidence : null,
      })),
      changed_symbol_ids: [...changed],
      impacted_symbol_ids: [...impacted],
      file_dependants: dependants,
      affected_files: [...affected].sort(),
      affected_tests: [...tests].sort(),
      boundaries,
    };
    if (Buffer.byteLength(JSON.stringify(output)) > bounds.output_bytes)
      throw new Error("OUTPUT_LIMIT");
    return output;
  } finally {
    cg.close();
  }
}

async function main() {
  // Always create a new index in a writable tmpfs; /input is the only source mount.
  await mkdir("/work/home", { mode: 0o700 });
  await cp("/input/target", "/work/target", {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
  });
  const request = JSON.parse(await readFile("/input/request.json", "utf8"));
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    const result = await collectGraph("/work/target", request);
    process.stdout.write(JSON.stringify(result));
  } finally {
    Object.assign(console, original);
  }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    // Fixed error codes only; upstream messages may contain source/configuration text.
    process.stderr.write(
      error instanceof Error && error.message === "OUTPUT_LIMIT"
        ? "OUTPUT_LIMIT\n"
        : "INDEX_FAILED\n",
    );
    process.exitCode = error instanceof Error && error.message === "OUTPUT_LIMIT" ? 75 : 1;
  });
}
