import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";

import { SDK_REACH_BASELINE } from "./sdk-reach-baseline.mjs";

/**
 * The headless session factory and its services, relative to `packages/`. The package index (`src/index.ts`) is not ratcheted:
 * it exports the run modes (`main`, RPC and print), so it reaches the terminal layers by design.
 */
export const SDK_ENTRIES = [
	"coding-agent/src/core/agent-session/create-session.ts",
	"coding-agent/src/core/agent-session-services.ts",
];
/** Interactive layers a headless session must not load: these packages and the terminal modes folder. */
export const SDK_FORBIDDEN_PACKAGES = ["tui", "webview"];
/** Subpaths of a forbidden package that import nothing interactive, so a headless consumer may load them. */
export const SDK_HEADLESS_SUBPATHS = [
	"@octocodeai/octocode-tui/ansi",
	"@octocodeai/octocode-tui/text",
	"@octocodeai/octocode-tui/multiplexer",
];
export const SDK_FORBIDDEN_PREFIX = "coding-agent/src/modes/";

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Static value imports and re-exports of a module. `import type` and `export type` are elided; an inline `{ type X }`
 * import is kept because `verbatimModuleSyntax` compiles it to a side-effect import. Dynamic `import()` is lazy and
 * is not an eager dependency of the entry.
 */
export function valueImports(text, file) {
	const lang = file.endsWith(".tsx") ? "tsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js";
	const imports = [];
	for (const node of parseAst(text, { lang, sourceType: "module" }, file).body) {
		const isImport = node.type === "ImportDeclaration";
		const isReExport = node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration";
		if (!(isImport || isReExport) || !node.source) continue;
		if (isImport ? node.importKind === "type" : node.exportKind === "type") continue;
		imports.push(node.source.value);
	}
	return imports;
}

function resolveRelative(from, specifier, files) {
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
	const stem = base.replace(/\.[cm]?js$/, "");
	return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
		(candidate) => files.has(candidate),
	);
}

/**
 * Walk static value imports from the entries and return the edges that reach a forbidden layer, as
 * `importer -> package` for a forbidden package or `importer -> file` for a file under the modes folder. The walk does
 * not continue into a forbidden target, so each cut removes exactly the edges behind it.
 * `files` maps a path relative to `packages/` to its value imports; `packageNames` maps package names to directories.
 */
export function sdkReachEdges(files, packageNames, { entries = SDK_ENTRIES, prefix = SDK_FORBIDDEN_PREFIX } = {}) {
	const seen = new Set(entries.filter((entry) => files.has(entry)));
	const queue = [...seen];
	const edges = new Set();
	for (const file of queue) {
		for (const specifier of files.get(file)) {
			if (!specifier.startsWith(".")) {
				if (SDK_HEADLESS_SUBPATHS.includes(specifier)) continue;
				const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
				const target = packageNames.get(name);
				if (SDK_FORBIDDEN_PACKAGES.includes(target)) edges.add(`${file} -> ${target}`);
				continue;
			}
			const target = resolveRelative(file, specifier, files);
			if (!target) continue;
			if (target.startsWith(prefix)) edges.add(`${file} -> ${target}`);
			else if (!seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return [...edges].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Compare the reached edges with the ratcheted baseline: new edges and baseline edges that no longer exist both fail. */
export function checkSdkReachability(files, packageNames, baseline = SDK_REACH_BASELINE, options = {}) {
	const { entries = SDK_ENTRIES } = options;
	const issues = entries
		.filter((entry) => !files.has(entry))
		.map((entry) => `sdk-reachability: entry ${entry} does not exist`);
	const edges = sdkReachEdges(files, packageNames, options);
	for (const edge of edges)
		if (!baseline.includes(edge))
			issues.push(`sdk-reachability: ${edge} (SDK entry newly reaches it; not in its baseline)`);
	for (const edge of baseline)
		if (!edges.includes(edge))
			issues.push(`sdk-reachability: ${edge} is no longer reached (remove it from its baseline)`);
	return issues;
}

export function scanSdkReachability(root) {
	const files = new Map();
	const packageNames = new Map();
	for (const dir of fs.readdirSync(path.join(root, "packages"))) {
		const manifest = path.join(root, "packages", dir, "package.json");
		if (!fs.existsSync(manifest)) continue;
		packageNames.set(JSON.parse(fs.readFileSync(manifest, "utf8")).name, dir);
		const walk = (folder) =>
			fs
				.readdirSync(folder, { withFileTypes: true })
				.flatMap((entry) =>
					entry.isDirectory()
						? walk(path.join(folder, entry.name))
						: SOURCE_FILE.test(entry.name) && !/\.(generated|d)\.[cm]?ts$/.test(entry.name)
							? [path.join(folder, entry.name)]
							: [],
				);
		const source = path.join(root, "packages", dir, "src");
		if (!fs.existsSync(source)) continue;
		for (const file of walk(source))
			files.set(
				path.relative(path.join(root, "packages"), file).split(path.sep).join("/"),
				valueImports(fs.readFileSync(file, "utf8"), file),
			);
	}
	return checkSdkReachability(files, packageNames);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const issues = scanSdkReachability(process.cwd());
	if (issues.length) {
		console.error(issues.join("\n"));
		process.exitCode = 1;
	}
}
