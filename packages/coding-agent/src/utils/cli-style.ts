import chalk, { chalkStderr } from "chalk";

/**
 * The one place pre-session command-line output (help, errors, package commands, startup diagnostics) gets its color,
 * by role. Roles follow the terminal interface: heading = bold, warn = yellow, error = red, success = green, dim =
 * chrome, link = cyan. Color is off under `NO_COLOR`, `OCTOCODE_NO_COLOR` and `--no-color` (see `disableCliColor`).
 */
export const cliStyle = {
	heading: (text: string): string => chalk.bold(text),
	warn: (text: string): string => chalk.yellow(text),
	error: (text: string): string => chalk.red(text),
	success: (text: string): string => chalk.green(text),
	dim: (text: string): string => chalk.dim(text),
	link: (text: string): string => chalk.cyan(text),
	italic: (text: string): string => chalk.italic(text),
	strikethrough: (text: string): string => chalk.strikethrough(text),
	underline: (text: string): string => chalk.underline(text),
} as const;

/** Turn every `cliStyle` role into plain text, on stdout and stderr. */
export function disableCliColor(): void {
	chalk.level = 0;
	chalkStderr.level = 0;
}
