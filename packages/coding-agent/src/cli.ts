#!/usr/bin/env node
import { runResearchCommand } from "./cli/research.ts";
import { setupCli } from "./cli/setup.ts";

const args = process.argv.slice(2);
if (args[0] === "completion") {
	const { runCompletionCommand } = await import("./cli/completion.ts");
	runCompletionCommand(args);
} else if (args[0] === "remote") {
	const { runRemoteCli } = await import("./octocode/remote/cli.ts");
	process.exitCode = await runRemoteCli(args.slice(1));
} else if (args[0] === "__web-daemon") {
	// The detached user-level web daemon (`/octocode` with OCTOCODE_WEB_DAEMON=1 starts it); not a user command.
	const { runWebDaemon } = await import("./octocode/web-daemon/main.ts");
	await runWebDaemon();
} else {
	setupCli();
	if (!runResearchCommand(args)) {
		const { main } = await import("./main.ts");
		await main(args);
	}
}
