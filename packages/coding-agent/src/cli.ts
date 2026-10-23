#!/usr/bin/env node
import { runResearchCommand } from "./cli/research.ts";
import { setupCli } from "./cli/setup.ts";

const args = process.argv.slice(2);
if (args[0] === "completion") {
	const { runCompletionCommand } = await import("./cli/completion.ts");
	runCompletionCommand(args);
} else {
	setupCli();
	if (!runResearchCommand(args)) {
		const { main } = await import("./main.ts");
		await main(args);
	}
}
