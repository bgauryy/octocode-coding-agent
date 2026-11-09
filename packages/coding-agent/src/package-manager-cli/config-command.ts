import chalk from "chalk";
import { selectConfiguration } from "../cli/configuration-selector.ts";
import { APP_NAME, getAgentDir } from "../config.ts";
import { parseConfigWords, runConfigWords } from "../configuration/command.ts";
import { createConfiguration } from "../configuration/index.ts";
import { printConfigCommandHelp } from "./help.ts";
import { createCommandSettingsManager, reportProjectTrustWarnings, reportSettingsErrors } from "./settings.ts";

/**
 * `octocode configuration [verb] [args] [--local|-l] [--trust] [--json]`: the catalog's verbs from the shell. Without a
 * verb it opens the selector on a terminal and lists otherwise. A refused change sets a non-zero exit code.
 */
export async function handleConfigCommand(args: string[]): Promise<boolean> {
	const [command, ...rest] = args;
	if (command === "config") {
		console.error(
			chalk.red(`"${APP_NAME} config" is now "${APP_NAME} configuration". Run "${APP_NAME} configuration --help".`),
		);
		process.exitCode = 1;
		return true;
	}
	if (command !== "configuration") return false;

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	const own = parseConfigWords(rest);
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = createCommandSettingsManager({ cwd, agentDir, trust: own.trust });
	reportProjectTrustWarnings(projectTrustWarnings);
	reportSettingsErrors(settingsManager, "configuration command");
	const catalog = createConfiguration({
		cwd,
		agentDir,
		settings: settingsManager,
		projectTrusted: settingsManager.isProjectTrusted(),
	});

	if (own.words.length === 0 && !own.json && process.stdin.isTTY && process.stdout.isTTY) {
		await selectConfiguration({ catalog, settingsManager, agentDir, local: own.local });
		return true;
	}

	const outcome = await runConfigWords(catalog, rest, `${APP_NAME} configuration`);
	await settingsManager.flush();
	if (own.json) console.log(JSON.stringify(outcome.json, null, 2));
	else
		for (const line of outcome.lines) (outcome.ok ? console.log : console.error)(outcome.ok ? line : chalk.red(line));
	if (!outcome.ok) process.exitCode = 1;
	return true;
}
