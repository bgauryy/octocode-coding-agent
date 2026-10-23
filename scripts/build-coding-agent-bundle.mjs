#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
// Bundled CommonJS dependencies call require(); an ES module has none, so each output file defines one.
const banner =
	'import { createRequire as __octocodeCreateRequire } from "node:module"; const require = __octocodeCreateRequire(import.meta.url);';
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	"jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
]);

const LAZY_JITI = "\0lazy-jiti";
const HTTPS_PROXY_AGENT = "\0https-proxy-agent-named-export";

// The source uses jiti/static so Bun embeds its Babel transform. The Node package replaces it with a synchronous lazy
// require so jiti loads only when importing an extension; Babel remains deferred until a cache miss needs transformation.
const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	resolveId(source) {
		if (source === "jiti/static") return LAZY_JITI;
	},
	load(id) {
		if (id !== LAZY_JITI) return;
		return {
			code: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			moduleType: "js",
		};
	},
};

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

/**
 * Bundle `input` for Node. Imports that do not resolve stay external and are recorded in `unresolved`; they must be
 * built-ins or optional packages listed in `allowedExternalPackages` (checked after both builds).
 */
async function bundle(input, output, unresolved) {
	const build = await rolldown({
		cwd: repoRoot,
		input,
		platform: "node",
		external: ["@silvia-odwyer/photon-node"],
		// Do not apply the monorepo's source-oriented path aliases while bundling compiled output. Release builds must
		// resolve the same package entries as an installed npm package.
		tsconfig: false,
		transform: { target: "node24", define: { OCTOCODE_BUNDLED_NODE: "true" } },
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
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
			// Whitespace and syntax only: identifiers keep their names for stack traces.
			minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
			sourcemap: false,
			...output,
		});
		return result.output.filter((item) => item.type === "chunk");
	} finally {
		await build.close();
	}
}

function validateExternalImports(unresolved) {
	const unexpected = [...unresolved].filter((path) => !isBuiltin(path) && !allowedExternalPackages.has(path));
	if (unexpected.length > 0) {
		throw new Error(
			`Bundle left unexpected external imports: ${unexpected.sort((a, b) => a.localeCompare(b)).join(", ")}`,
		);
	}
}

function findContainingOutput(chunks, outputDir, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const chunk of chunks) {
		if (chunk.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(outputDir, chunk.fileName);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(chunks) {
	return chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "octocode", "api", "cli.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const unresolved = new Set();
const mainChunks = await bundle(
	{
		"cli-runtime": join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
		"octocode-api": join(codingAgentDistDir, "octocode", "api", "cli.js"),
	},
	{ dir: bundleDir, entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
	unresolved,
);

const bedrockLoaderOutput = findContainingOutput(
	mainChunks,
	bundleDir,
	"packages/ai/dist/api/bedrock-converse-stream.lazy.js",
);
const oauthLoaderOutput = findContainingOutput(mainChunks, bundleDir, "packages/ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(
	mainChunks,
	bundleDir,
	"packages/coding-agent/dist/utils/image-resize.js",
);
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyEntryPoints = {
	anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
	"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
	"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
	"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
	meta: join(aiDistDir, "auth", "oauth", "meta.js"),
	"openai-chatgpt": join(aiDistDir, "auth", "oauth", "openai-chatgpt.js"),
	"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
	openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
	xai: join(aiDistDir, "auth", "oauth", "xai.js"),
};

// Every OAuth flow loaded through importOAuthModule() must have a lazy entry,
// otherwise the flow fails at runtime with a missing module error.
const oauthLoadSource = readFileSync(join(repoRoot, "packages", "ai", "src", "auth", "oauth", "load.ts"), "utf8");
for (const match of oauthLoadSource.matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)) {
	if (!(match[1] in lazyEntryPoints)) {
		throw new Error(`OAuth flow "${match[1]}" is lazily imported but has no lazy bundle entry`);
	}
}

// One self-contained file per lazy entry: each inlines its own dynamic imports rather than sharing chunks.
const lazyChunks = (
	await Promise.all(
		Object.entries(lazyEntryPoints).map(([name, input]) =>
			bundle(
				{ [name]: input },
				{ dir: dirname(bedrockLoaderOutput), entryFileNames: "[name].js", codeSplitting: false },
				unresolved,
			),
		),
	)
).flat();

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}
const chunks = [...mainChunks, ...lazyChunks];
validateExternalImports(unresolved);
// The runtime is imported after the compile cache is enabled, so its modules are cached too. It uses top-level await
// (lazy completion and main imports), which require() cannot load.
const cliLauncher = `#!/usr/bin/env node
import { enableCompileCache } from "node:module";

enableCompileCache();
await import("./cli-runtime.js");
`;
writeFileSync(join(bundleDir, "cli.js"), cliLauncher);
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);
chmodSync(join(bundleDir, "octocode-api.js"), 0o755);

const files = chunks.length + 1;
const mib = (outputBytes(chunks) + cliLauncher.length) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
