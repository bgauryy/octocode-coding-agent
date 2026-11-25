import { NoInputError } from "../cli/no-input.ts";
import { cliStyle } from "../utils/cli-style.ts";

/** Runs a command; a prompt it needed under `--no-input` ends the process with that message and exit code 1. */
export async function exitOnNoInput<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof NoInputError)) throw error;
		console.error(cliStyle.error(`Error: ${error.message}`));
		process.exit(1);
	}
}
