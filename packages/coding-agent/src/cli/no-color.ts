// The leaf, not the terminal interface package: `--help` must not load the TUI.
import { isColorForced } from "@octocodeai/octocode-common/force-color";
import { disableCliColor } from "../utils/cli-style.ts";

/**
 * Settle ANSI color for CLI output and the terminal interface. A flag is the user's explicit choice and wins over the
 * environment: `--no-color` exports `OCTOCODE_NO_COLOR` (and drops `FORCE_COLOR`), `--color` exports `FORCE_COLOR=1`
 * (and drops the no-color variables); with both, `--no-color` wins. Otherwise `FORCE_COLOR` (set, not `0`/`false`)
 * beats a non-empty `NO_COLOR` or `OCTOCODE_NO_COLOR` (https://no-color.org). The result is exported through the
 * environment, so the terminal interface and every subagent started from here follow it.
 */
export function applyNoColor(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
	if (argv.includes("--no-color")) {
		env.OCTOCODE_NO_COLOR = "1";
		delete env.FORCE_COLOR;
	} else if (argv.includes("--color")) {
		env.FORCE_COLOR = "1";
		delete env.NO_COLOR;
		delete env.OCTOCODE_NO_COLOR;
	}
	if (isColorForced(env)) return;
	if (!env.NO_COLOR && !env.OCTOCODE_NO_COLOR) return;
	disableCliColor();
}
