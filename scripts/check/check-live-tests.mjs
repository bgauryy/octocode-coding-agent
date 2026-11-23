#!/usr/bin/env node
/**
 * Paid tests (real provider or model requests) live in `*.live.test.ts` and run only through a package's `test:live`
 * script. This check loads every vitest config of every workspace the way a default run sees it and fails when a
 * default run would collect a live file or a test gated on credentials, and when a workspace with live files has no
 * `test:live` script.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packages = fileURLToPath(new URL("../../packages/", import.meta.url));

/** What vitest collects when a config sets no `include`. */
const DEFAULT_INCLUDE = ["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];
const LIVE_FILE = /\.live\.test\.[cm]?[jt]sx?$/;
const SKIP_GATE_WORDS =
	/API_KEY|_TOKEN|CREDENTIALS|Credentials|LIVE|resolveApiKey|apiKey|ApiKey|copilotToken|codexToken|openrouterKey/;

/** Why a test file reaches a paid provider or a credential store; empty for a file that stays offline. */
export function gateReasons(text) {
	const reasons = [];
	for (const [, condition] of text.matchAll(/\.(?:skipIf|runIf)\(([^\n]*)/g)) {
		if (SKIP_GATE_WORDS.test(condition)) reasons.push(`skipIf/runIf on credentials: ${condition.trim().slice(0, 60)}`);
	}
	if (/\benv\b[.[]["']?(?:TESTKIT_LIVE|OCTOCODE_LIVE_\w+)/.test(text)) reasons.push("reads a live-test flag");
	if (/\bresolveApiKey\(|from "\.\/oauth\.ts"/.test(text)) reasons.push("resolves stored provider credentials");
	if (/Boolean\(process\.env\.\w*(?:API_KEY|TOKEN)\)/.test(text))
		reasons.push("enabled by an API key in the environment");
	return reasons;
}

/** The files a config collects: under `root`, matching `include` and not `exclude` (globs relative to `root`). */
export function collected(files, { include = DEFAULT_INCLUDE, exclude = [] }) {
	return files.filter(
		({ file }) => include.some((glob) => matchesGlob(file, glob)) && !exclude.some((glob) => matchesGlob(file, glob)),
	);
}

/** One line per default-run file that is live or credential-gated; `files` are `{ file, text }` relative to the config's root. */
export function violations(configName, files, test) {
	return collected(files, test).flatMap(({ file, text }) => {
		const reasons = LIVE_FILE.test(file) ? ["live file"] : gateReasons(text);
		return reasons.map((reason) => `${configName}: ${file}: ${reason}`);
	});
}

/** Workspaces that hold `*.live.test.*` files without a `test:live` script. */
export function missingLiveScripts(workspaces) {
	return workspaces
		.filter(({ files, scripts }) => files.some(({ file }) => LIVE_FILE.test(file)) && !scripts?.["test:live"])
		.map(({ name }) => `${name}: has live tests but no test:live script`);
}

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) return [];
		const full = resolve(dir, entry.name);
		return entry.isDirectory() ? walk(full) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
	});
}

async function main() {
	// A live run would exclude nothing: check what a default run collects, whatever the caller exported.
	delete process.env.OCTOCODE_LIVE_TESTS;
	const problems = [];
	const workspaces = [];
	for (const name of readdirSync(packages)) {
		const root = resolve(packages, name);
		const manifest = resolve(root, "package.json");
		if (!existsSync(manifest)) continue;
		const files = walk(root).map((full) => ({
			file: relative(root, full).split("\\").join("/"),
			text: readFileSync(full, "utf8"),
		}));
		workspaces.push({ name, files, scripts: JSON.parse(readFileSync(manifest, "utf8")).scripts });
		for (const config of readdirSync(root).filter((entry) => /^vitest.*\.config\.[cm]?ts$/.test(entry))) {
			const loaded = (await import(pathToFileURL(resolve(root, config)).href)).default;
			problems.push(...violations(`${name}/${config}`, files, loaded.test ?? {}));
		}
	}
	problems.push(...missingLiveScripts(workspaces));
	if (problems.length) {
		console.error(
			`A default test run would reach a paid provider. Rename the test to *.live.test.ts (run by \`yarn test:live\`), or take the credential gate out of an offline test:\n${problems.map((line) => `  ${line}`).join("\n")}`,
		);
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
