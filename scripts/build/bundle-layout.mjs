/**
 * The files of `dist/bundle/` and the launchers that choose among them. `build-coding-agent.mjs` writes them;
 * `publish-stage.mjs` checks that every other `.js` there is no larger than a launcher.
 */
import { join } from "node:path";

/**
 * Commands that answer from a small file of their own, given alone on the command line, so they never compile the
 * whole bundle. `src/cli.ts` makes the same choice when it runs from source. `entry` is relative to the package's `src/`.
 */
export const FAST_COMMANDS = [
	{ file: "version.js", entry: join("cli", "version-only.ts"), run: "printVersionOnly", flags: ["--version", "-v"] },
	{ file: "help.js", entry: join("cli", "args", "help-only.ts"), run: "printHelpOnly", flags: ["--help", "-h"] },
];

/** The code files beside the launchers: the bundle, its workers (each its own file by design) and the fast commands. */
export const BUNDLE_CODE_FILES = new Set([
	"octocode.js",
	"db-writer-worker.js",
	"archive-index-worker.js",
	...FAST_COMMANDS.map(({ file }) => file),
]);

/**
 * Modules a worker file must not bundle: provider SDKs and the terminal UI. A worker compiles and holds everything it
 * bundles, and these arrive only through an import of a hub module (`shared/util.ts`, a package root) where a leaf
 * module would do; the archive-index worker once carried 6 MB of them for 170 KB of its own code.
 */
const WORKER_FOREIGN = [
	/[\\/]packages[\\/](ai|tui)[\\/]/,
	/[\\/]node_modules[\\/](@ai-sdk[\\/]|ai[\\/]|highlight\.js[\\/]|marked[\\/])/,
];

/** The ids among a worker chunk's `moduleIds` that it must not bundle (`WORKER_FOREIGN`). */
export function workerForeignModules(moduleIds) {
	return moduleIds.filter((id) => WORKER_FOREIGN.some((pattern) => pattern.test(id)));
}

/**
 * A launcher: it turns on the compile cache, then imports the bundle and calls `run`. With `fast`, a fast command given
 * alone loads only its own file. The bundle uses top-level await, which require() cannot load.
 */
export function launcherSource(run, fast = []) {
	const lines = [
		"#!/usr/bin/env node",
		'import { enableCompileCache } from "node:module";',
		"",
		"enableCompileCache();",
	];
	if (fast.length === 0)
		return `${[...lines, `const { ${run} } = await import("./octocode.js");`, `await ${run}();`].join("\n")}\n`;
	lines.push("const only = process.argv.length === 3 ? process.argv[2] : undefined;");
	fast.forEach((command, index) => {
		const test = command.flags.map((flag) => `only === ${JSON.stringify(flag)}`).join(" || ");
		lines.push(`${index === 0 ? "if" : "else if"} (${test}) (await import("./${command.file}")).${command.run}();`);
	});
	lines.push(`else await (await import("./octocode.js")).${run}();`);
	return `${lines.join("\n")}\n`;
}
