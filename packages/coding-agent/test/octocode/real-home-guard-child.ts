import { agentDbPath } from "../../src/storage/state-paths.ts";

// A process a test started (a CLI child, a detached daemon) resolving the agent database from its own environment.
try {
	process.stdout.write(agentDbPath());
} catch (error) {
	process.stderr.write(error instanceof Error ? error.message : String(error));
	process.exitCode = 3;
}
