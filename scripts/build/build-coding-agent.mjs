#!/usr/bin/env node
/**
 * Builds packages/coding-agent:
 * - `dist/bundle/octocode.js`: all the JavaScript in one Rolldown file, straight from the TypeScript sources, with a small
 *   launcher per command beside it, and `dist/bundle/db-writer-worker.js`: the database writer's worker on its own, so
 *   each process's writer thread loads the database code instead of the whole bundle; `version.js` and `help.js` answer
 *   `--version` and `--help` without compiling the bundle (`bundle-layout.mjs`);
 * - the runtime assets the bundle reads by path (`dist/theme`, `dist/core/export-html`, `dist/octocode/...`, ...), the
 *   native terminal helpers (`dist/native`), the sandbox library's helpers (`dist/bundle/vendor`) and the licenses of
 *   everything compiled in (`dist/licenses`).
 * The private source workspaces (mcp, acp, common) compile in through their relative imports. Workspace libraries (ai,
 * agent-core, tui, ...) resolve through their package exports and compile in too: build them first.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { readWorkspacePackages, sourceWorkspaceGroups } from "../lib/source-workspaces.mjs";
import { BUNDLE_CODE_FILES, FAST_COMMANDS, launcherSource, workerForeignModules } from "./bundle-layout.mjs";
import { copyNative } from "./copy-native.mjs";
import { copySandboxVendor } from "./sandbox-vendor.mjs";
import { stageBashParser } from "./stage-bash-parser.mjs";
import { renderThirdPartyNotices } from "./third-party-notices.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const src = join(packageDir, "src");
const dist = join(packageDir, "dist");
const bundleDir = join(dist, "bundle");
const tuiNative = join(repoRoot, "packages", "tui", "native");

// Bundled CommonJS dependencies call require(); an ES module has none, so the output defines one.
const banner =
	'import { createRequire as __octocodeCreateRequire } from "node:module"; const require = __octocodeCreateRequire(import.meta.url);';
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
]);

const HTTPS_PROXY_AGENT = "\0https-proxy-agent-named-export";

// A dynamic import of https-proxy-agent gets a module with the named export, whatever the package's module format.
const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	resolveId(source, importer, extra) {
		if (source !== "https-proxy-agent") return;
		if (importer === HTTPS_PROXY_AGENT) return this.resolve(source, join(repoRoot, "package.json"), { skipSelf: true });
		if (extra?.kind === "dynamic-import") return HTTPS_PROXY_AGENT;
	},
	load(id) {
		if (id === HTTPS_PROXY_AGENT)
			return { code: 'export { HttpsProxyAgent } from "https-proxy-agent";', moduleType: "js" };
	},
};

// The AI package hides Node-only code behind variable-specifier imports so browser bundles cannot follow them. Here they
// become literal dynamic imports: Rolldown puts that code in the one file and still runs it only on first use.
const LAZY_LOADER = /packages\/ai\/dist\/(?:auth\/oauth\/load|api\/bedrock-converse-stream\.lazy)\.js$/;
const LAZY_IMPORT = /\b(?:importOAuthModule|importNodeOnlyApi)\("\.\/([^"]+)\.ts"\)/g;
const inlineLazyImportsPlugin = {
	name: "inline-lazy-imports",
	transform(code, id) {
		if (!LAZY_LOADER.test(id.replaceAll("\\", "/"))) return;
		const inlined = code.replace(LAZY_IMPORT, 'import("./$1.js")');
		if (inlined === code) this.error(`No lazy import to inline in ${id}; the bundle would miss that code`);
		return { code: inlined, moduleType: "js" };
	},
};

/** Rolldown leaves non-ASCII raw where escaping would change behavior, such as tagged template text (`String.raw`). */
function assertAscii(chunk) {
	const at = chunk.code.search(/[\u0080-\uffff]/);
	if (at === -1) return;
	const context = JSON.stringify(chunk.code.slice(Math.max(0, at - 60), at + 20));
	throw new Error(
		`${chunk.fileName} has a non-ASCII character at ${at}: ${context}. Use an escape or an untagged string there.`,
	);
}

/**
 * Bundle `input` for Node into one file. Imports that do not resolve stay external and are recorded in `unresolved`;
 * they must be built-ins or optional packages listed in `allowedExternalPackages`.
 */
async function bundle(input, output, unresolved) {
	const build = await rolldown({
		cwd: repoRoot,
		input,
		platform: "node",
		external: ["@silvia-odwyer/photon-node"],
		// Do not apply the monorepo's source path aliases: workspace libraries must resolve the same package entries as an
		// installed npm package. Relative imports (including the private source workspaces) need no configuration.
		tsconfig: false,
		transform: { target: "node24", define: { OCTOCODE_BUNDLED_NODE: "true" } },
		plugins: [httpsProxyAgentNamedExportPlugin, inlineLazyImportsPlugin],
		onLog(level, log, defaultHandler) {
			if (log.code === "UNRESOLVED_IMPORT" && log.exporter) {
				unresolved.add(log.exporter);
				return;
			}
			if (level === "warn" && ["EVAL", "CIRCULAR_DEPENDENCY", "MIXED_EXPORTS", "EMPTY_IMPORT_META"].includes(log.code))
				return;
			defaultHandler(level, log);
		},
	});
	try {
		const result = await build.write({
			format: "esm",
			banner,
			comments: { legal: false },
			// Non-ASCII escaped (`\uXXXX`): a source with any character above U+00FF makes V8 hold the whole file at two
			// bytes per character, in every process that loads it.
			charset: "ascii",
			// Whitespace and syntax only: identifiers keep their names for stack traces.
			minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
			sourcemap: false,
			...output,
		});
		const chunks = result.output.filter((item) => item.type === "chunk");
		for (const chunk of chunks) assertAscii(chunk);
		return chunks;
	} finally {
		await build.close();
	}
}

/**
 * The database writer's worker (`packages/db/src/writer/client.ts` starts it by this name beside the bundle). A separate
 * file: started as the bundle, every writer thread would compile and hold all of it.
 */
const DB_WRITER_WORKER = {
	name: "db-writer-worker",
	entry: join(repoRoot, "packages", "db", "src", "writer", "worker-entry.ts"),
};

/** The archive-index worker (`history/index/client.ts` starts it by this name beside the bundle), separate for the same reason. */
const ARCHIVE_INDEX_WORKER = {
	name: "archive-index-worker",
	entry: join(src, "octocode", "history", "index", "worker-entry.ts"),
};

/** The one bundle file and its launchers, which turn on the compile cache before loading it, and the writer's worker. */
async function buildBundle() {
	const unresolved = new Set();
	const chunks = await bundle(
		{ octocode: join(src, "bundle.ts") },
		{ dir: bundleDir, entryFileNames: "[name].js", codeSplitting: false },
		unresolved,
	);
	if (chunks.length !== 1) throw new Error(`Expected one bundle file, got ${chunks.length}`);
	const worker = await bundle(
		{ [DB_WRITER_WORKER.name]: DB_WRITER_WORKER.entry },
		{ dir: bundleDir, entryFileNames: "[name].js", codeSplitting: false },
		unresolved,
	);
	if (worker.length !== 1) throw new Error(`Expected one database writer worker file, got ${worker.length}`);
	const indexWorker = await bundle(
		{ [ARCHIVE_INDEX_WORKER.name]: ARCHIVE_INDEX_WORKER.entry },
		{ dir: bundleDir, entryFileNames: "[name].js", codeSplitting: false },
		unresolved,
	);
	if (indexWorker.length !== 1) throw new Error(`Expected one archive index worker file, got ${indexWorker.length}`);
	for (const chunk of [...worker, ...indexWorker]) {
		const foreign = workerForeignModules(Object.keys(chunk.modules));
		if (foreign.length > 0)
			throw new Error(
				`${chunk.fileName} bundles ${foreign.length} provider or terminal modules, first ${foreign[0]}: import leaf modules, not hubs`,
			);
	}
	const fast = [];
	for (const command of FAST_COMMANDS) {
		const name = command.file.replace(/\.js$/, "");
		const files = await bundle(
			{ [name]: join(src, command.entry) },
			{ dir: bundleDir, entryFileNames: "[name].js", codeSplitting: false },
			unresolved,
		);
		if (files.length !== 1) throw new Error(`Expected one ${command.file}, got ${files.length}`);
		fast.push(...files);
	}

	const unexpected = [...unresolved].filter((path) => !isBuiltin(path) && !allowedExternalPackages.has(path));
	if (unexpected.length > 0)
		throw new Error(
			`Bundle left unexpected external imports: ${unexpected.sort((a, b) => a.localeCompare(b)).join(", ")}`,
		);

	// `@opencode-ai/models/snapshot` carries the whole model list (about 7.5 MB); the catalog reads models.dev at run time instead.
	const snapshot = [...chunks, ...worker, ...indexWorker, ...fast]
		.flatMap((chunk) => chunk.moduleIds)
		.filter((id) => /[\\/]@opencode-ai[\\/]models[\\/]dist[\\/]snapshot/.test(id));
	if (snapshot.length > 0)
		throw new Error(`The bundle compiled in the models snapshot (${snapshot[0]}); import only the package root`);

	// The bundle is imported after the compile cache is enabled, so it is cached too.
	for (const [file, run, commands] of [
		["cli.js", "runCli", FAST_COMMANDS],
		["octocode-api.js", "runApiCli"],
		["rpc-entry.js", "runRpcEntry"],
	]) {
		writeFileSync(join(bundleDir, file), launcherSource(run, commands));
		chmodSync(join(bundleDir, file), 0o755);
	}
	const code = [...chunks, ...worker, ...indexWorker, ...fast].map((chunk) => chunk.fileName);
	const unlisted = code.filter((file) => !BUNDLE_CODE_FILES.has(file));
	if (unlisted.length > 0) throw new Error(`Bundle code files missing from BUNDLE_CODE_FILES: ${unlisted.join(", ")}`);

	mkdirSync(join(dist, "licenses"), { recursive: true });
	const notices = renderThirdPartyNotices(
		[...chunks, ...worker, ...indexWorker, ...fast].flatMap((chunk) => chunk.moduleIds),
		repoRoot,
	);
	writeFileSync(join(dist, "licenses", "THIRD_PARTY_NOTICES.md"), notices.text);
	const size = (Buffer.byteLength(chunks[0].code) / (1024 * 1024)).toFixed(1);
	const workerSize = (Buffer.byteLength(worker[0].code) / 1024).toFixed(0);
	const fastSizes = fast.map((chunk) => `${chunk.fileName} (${(Buffer.byteLength(chunk.code) / 1024).toFixed(0)} KiB)`);
	return `${relative(repoRoot, join(bundleDir, chunks[0].fileName))} (${size} MiB, ${notices.count} third-party packages), ${worker[0].fileName} (${workerSize} KiB), ${indexWorker[0].fileName}, ${fastSizes.join(", ")}`;
}

/** Files the bundle reads by path at run time, and the licenses of code compiled into it. */
function copyAssets(hostedWorkspaces) {
	const copy = (from, to) => cpSync(join(src, from), join(dist, to), { recursive: true });
	const copyMatching = (from, to, pattern) => {
		for (const name of readdirSync(join(src, from)).filter((file) => pattern.test(file)))
			copy(join(from, name), join(to, name));
	};
	copyMatching("theme", "theme", /\.json$/);
	copyMatching("modes/interactive/assets", "modes/interactive/assets", /\.png$/);
	copyMatching("core/export-html", "core/export-html", /^template\.(html|css)$/);
	copyMatching("core/export-html/script", "core/export-html/script", /\.js$/);
	copyMatching("core/export-html/vendor", "core/export-html/vendor", /\.js$/);
	// Prompt Markdown and every core skill (`getNativeDir`).
	copyNative(join(src, "octocode", "native"), join(dist, "octocode", "native"));
	copyMatching("octocode/tool-input/codex-patch", "licenses/codex-patch", /^(LICENSE|NOTICE)$/);
	for (const { directory, mount } of hostedWorkspaces) {
		const licenses = join(directory, "LICENSES");
		if (existsSync(licenses)) cpSync(licenses, join(dist, "licenses", mount), { recursive: true });
	}
	// `getNativeModuleCandidates` looks beside the bundle's parent directory once the TUI package is compiled in.
	for (const platform of readdirSync(tuiNative, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
		const prebuilds = join(tuiNative, platform.name, "prebuilds");
		if (existsSync(prebuilds)) cpSync(prebuilds, join(dist, "native", platform.name, "prebuilds"), { recursive: true });
	}
	stageBashParser(join(dist, "bash-parser"));
	// The sandbox library compiled into the bundle runs its prebuilt helpers from `vendor/` beside the bundle file.
	copySandboxVendor(packageDir, bundleDir);
}

export async function buildCodingAgent() {
	const packages = readWorkspacePackages(repoRoot);
	const { hosts, issues } = sourceWorkspaceGroups(packages);
	if (issues.length > 0) throw new Error(issues.join("\n"));
	const hostedWorkspaces = [...hosts]
		.filter(([name, host]) => name !== host && host === "coding-agent")
		.map(([name]) => ({ directory: join(repoRoot, "packages", name), mount: packages[name].octocodeSource.mount }));

	const startedAt = performance.now();
	rmSync(dist, { force: true, recursive: true });
	mkdirSync(bundleDir, { recursive: true });
	const bundled = await buildBundle();
	copyAssets(hostedWorkspaces);
	const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
	console.log(`Built ${bundled} and assets in ${seconds}s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildCodingAgent();
