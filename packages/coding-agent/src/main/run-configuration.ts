import chalk from "chalk";
import type { Args } from "../cli/args.ts";
import { applyRunFlags, hasRunFlags, runFlagErrors } from "../configuration/run-flags.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

/**
 * Applies `--enable`, `--disable` and `--set` to `settings` in memory, before tools and resources load. A flag the
 * catalog refuses is reported with its reason and suggestions, and the run does not start.
 */
export async function applyRunConfiguration(
	parsed: Args,
	context: { cwd: string; agentDir: string; settings: SettingsManager; projectTrusted: boolean },
): Promise<void> {
	if (!hasRunFlags(parsed)) return;
	const refused = await applyRunFlags(parsed, context);
	if (refused.length > 0) throw new RunConfigurationError(runFlagErrors(refused));
}

class RunConfigurationError extends Error {
	readonly lines: string[];
	constructor(lines: string[]) {
		super(lines.join("\n"));
		this.lines = lines;
	}
}

/** `applyRunConfiguration` for the start of `main()`: prints the refusals and exits non-zero. */
export async function applyRunConfigurationOrExit(
	parsed: Args,
	context: Parameters<typeof applyRunConfiguration>[1],
): Promise<void> {
	try {
		await applyRunConfiguration(parsed, context);
	} catch (error) {
		if (!(error instanceof RunConfigurationError)) throw error;
		for (const line of error.lines) console.error(chalk.red(line));
		process.exit(1);
	}
}
