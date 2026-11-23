#!/usr/bin/env node
import module from "node:module";

// Reuse compiled code across starts (every subagent is a fresh process), as the bundle's entry does. Before any other
// import: the modules loaded below are compiled through it. `NODE_COMPILE_CACHE` picks the folder,
// `NODE_DISABLE_COMPILE_CACHE` turns it off; a Node without the API starts as before.
try {
	module.enableCompileCache?.();
} catch {
	// An unwritable cache folder costs only the speed-up.
}

const args = process.argv.slice(2);
// `--version` and `--help` alone load only their own modules. The bundle's `cli.js` launcher makes the same choice
// before it loads the bundle (`FAST_COMMANDS` in `scripts/build/bundle-layout.mjs`).
const only = args.length === 1 ? args[0] : undefined;
if (only === "--version" || only === "-v") {
	const { printVersionOnly } = await import("./cli/version-only.ts");
	printVersionOnly();
} else if (only === "--help" || only === "-h") {
	const { printHelpOnly } = await import("./cli/args/help-only.ts");
	printHelpOnly();
} else if (args[0] === "completion") {
	const { runCompletionCommand } = await import("./cli/completion.ts");
	runCompletionCommand(args);
} else if (args[0] === "remote") {
	const { runRemoteCli } = await import("./octocode/remote/cli.ts");
	process.exitCode = await runRemoteCli(args.slice(1));
} else if (args[0] === "__web-daemon") {
	// The detached user-level web daemon (`/web` and `/remote` start it); not a user command.
	const { runWebDaemon } = await import("./octocode/web-daemon/main.ts");
	await runWebDaemon();
} else {
	const { setupCli } = await import("./cli/setup.ts");
	setupCli(args);
	const { flushCompileCacheOnNextRequest } = await import("./cli/compile-cache.ts");
	flushCompileCacheOnNextRequest();
	const { main } = await import("./main.ts");
	await main(args);
}
