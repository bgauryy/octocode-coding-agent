import chalk from "chalk";
import { printHelp } from "./help.ts";

/** `--help` alone, before the session modules load: the same text, with `NO_COLOR` applied as `setupCli` does. */
export function printHelpOnly(): void {
	if (process.env.NO_COLOR) chalk.level = 0;
	printHelp();
}
