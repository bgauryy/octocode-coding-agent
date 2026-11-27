import { applyNoColor } from "../no-color.ts";
import { printHelp } from "./help.ts";

/** `--help` alone, before the session modules load: the same text, with the color environment applied as `setupCli` does. */
export function printHelpOnly(): void {
	applyNoColor([]);
	printHelp();
}
