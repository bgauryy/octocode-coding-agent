import { existsSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rolldown } from "rolldown";

const errorLogPath = join(tmpdir(), "octocode-browser-smoke-errors.log");
const generatedCatalogDataDir = join(process.cwd(), "packages/ai/src/providers/data");
const EMPTY_CATALOG = "\0empty-generated-model-catalog:";

// Fresh checkouts do not materialize provider JSON until model data is hydrated.
const generatedCatalogDataPlugin = {
	name: "generated-model-catalog",
	resolveId(source, importer) {
		if (!importer || !/^\.\/data\/[^/]+\.json$/.test(source)) return;
		const path = resolve(dirname(importer), source);
		if (dirname(path) !== generatedCatalogDataDir || existsSync(path)) return;
		return EMPTY_CATALOG + path;
	},
	load(id) {
		if (id.startsWith(EMPTY_CATALOG)) return { code: "{}", moduleType: "json" };
	},
};

// A browser bundle must not import Node: Rolldown would leave a built-in import external, so refuse it here. A guarded
// `require()` (for example a Bun-only branch) is a runtime decision, not a static import, and stays allowed.
const browserOnlyPlugin = {
	name: "browser-only",
	resolveId(source, importer, extra) {
		if (isBuiltin(source) && extra?.kind === "import-statement")
			this.error(`Node built-in "${source}" imported by ${importer ?? "an entry"}`);
	},
};

/** Bundle for the browser; resolves to every module the graph reached and the output chunks. */
async function bundleForBrowser(input, plugins = []) {
	let reached = [];
	const bundle = await rolldown({
		input,
		platform: "browser",
		// The workspace path aliases point package imports at their sources, as for the type checker.
		tsconfig: "tsconfig.json",
		plugins: [
			browserOnlyPlugin,
			...plugins,
			{
				name: "graph",
				buildEnd() {
					reached = [...this.getModuleIds()];
				},
			},
		],
		onLog(level, log) {
			if (level === "warn" && log.code === "UNRESOLVED_IMPORT") throw new Error(log.message);
		},
	});
	try {
		const { output } = await bundle.generate({ format: "esm" });
		return { reached, chunks: output.filter((item) => item.type === "chunk") };
	} finally {
		await bundle.close();
	}
}

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function findInput(inputs, suffix) {
	return inputs.find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

function includesNodePackage(inputs, packageName) {
	const marker = `node_modules/${packageName}/`;
	return inputs.some((input) => normalizePath(input).includes(marker));
}

try {
	await bundleForBrowser(["packages/contracts/src/index.ts", "packages/webview/src/index.ts"]);
	await bundleForBrowser("scripts/check/browser-smoke-entry.ts", [generatedCatalogDataPlugin]);

	const agentTreeshake = await bundleForBrowser("scripts/check/agent-treeshake-smoke-entry.ts", [
		generatedCatalogDataPlugin,
	]);
	const inputs = agentTreeshake.reached;
	for (const forbiddenInput of [
		"packages/ai/src/compat.ts",
		"packages/ai/src/models.generated.ts",
		"packages/ai/src/providers/all.ts",
	]) {
		const includedInput = findInput(inputs, forbiddenInput);
		if (includedInput) {
			throw new Error(`Agent selective-provider bundle unexpectedly includes ${includedInput}`);
		}
	}

	const contributingInputs = new Set(
		agentTreeshake.chunks.flatMap((chunk) =>
			Object.entries(chunk.modules)
				.filter(([, contribution]) => contribution.renderedLength > 0)
				.map(([input]) => input),
		),
	);
	const catalogInputs = Array.from(contributingInputs).filter((input) =>
		normalizePath(input).includes("packages/ai/src/providers/data/"),
	);
	if (catalogInputs.length !== 1 || !normalizePath(catalogInputs[0]).endsWith("/anthropic.json")) {
		throw new Error(
			`Agent selective-provider bundle catalogs: expected only anthropic.json, found ${catalogInputs.join(", ") || "none"}`,
		);
	}

	const aiSdkPackages = [
		"@ai-sdk/anthropic",
		"@aws-sdk/client-bedrock-runtime",
		"@google/genai",
		"@mistralai/mistralai",
		"openai",
	];
	const includedAiSdkPackages = aiSdkPackages.filter((packageName) => includesNodePackage(inputs, packageName));
	if (includedAiSdkPackages.length !== 1 || includedAiSdkPackages[0] !== "@ai-sdk/anthropic") {
		throw new Error(
			`Agent selective-provider bundle SDKs: expected only @ai-sdk/anthropic, found ${includedAiSdkPackages.join(", ") || "none"}`,
		);
	}

	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location ? `${entry.location.file}:${entry.location.line}:${entry.location.column}` : "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
