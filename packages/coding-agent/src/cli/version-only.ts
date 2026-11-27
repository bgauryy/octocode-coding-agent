import { VERSION } from "../config.ts";

/** `--version` alone, before the session modules load: the same line `--version` prints after parsing every option. */
export function printVersionOnly(): void {
	console.log(VERSION);
}
