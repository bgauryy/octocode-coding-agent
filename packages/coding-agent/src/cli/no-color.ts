import chalk, { chalkStderr } from "chalk";

/**
 * Turn off ANSI color in CLI output when `NO_COLOR` (https://no-color.org) or `OCTOCODE_NO_COLOR` is non-empty, or
 * `--no-color` is among `argv`. `--no-color` is also exported as `OCTOCODE_NO_COLOR`, so the terminal interface and
 * every subagent started from here follow it.
 */
export function applyNoColor(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
	if (argv.includes("--no-color")) env.OCTOCODE_NO_COLOR = "1";
	if (!env.NO_COLOR && !env.OCTOCODE_NO_COLOR) return;
	chalk.level = 0;
	chalkStderr.level = 0;
}
