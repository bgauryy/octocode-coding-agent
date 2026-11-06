import chalk from "chalk";
import { selectConfig } from "../cli/config-selector.ts";
import { APP_NAME, getAgentDir } from "../config.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import { SWITCHABLE_BUILTIN_IDS } from "../core/features/builtin-ids.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { CONFIG_COMMAND_USAGE, printConfigCommandHelp } from "./help.ts";
import {
	createCommandSettingsManager,
	FOLDER_NOT_TRUSTED_HINT,
	reportProjectTrustWarnings,
	reportSettingsErrors,
} from "./settings.ts";

export async function handleConfigCommand(args: string[]): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	let local = false;
	let trust = false;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "--trust") {
			trust = true;
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "config".`));
			console.error(chalk.dim(`Use "${APP_NAME} --help" or "${CONFIG_COMMAND_USAGE}".`));
			process.exitCode = 1;
			return true;
		} else {
			console.error(chalk.red(`Unexpected argument ${arg}.`));
			console.error(chalk.dim(`Usage: ${CONFIG_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = createCommandSettingsManager({
		cwd,
		agentDir,
		trust,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red(`${FOLDER_NOT_TRUSTED_HINT} Project resource config was not changed.`));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "config command");
	const builtinExtensions = [...SWITCHABLE_BUILTIN_IDS];
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const globalResolvedPaths = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
		builtinExtensions,
	}).resolve();
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				builtinExtensions,
			}).resolve()
		: globalResolvedPaths;

	await selectConfig({
		resolvedPaths: { global: globalResolvedPaths, project: projectResolvedPaths },
		settingsManager,
		cwd,
		agentDir,
		writeScope: local ? "project" : "global",
		projectModeAvailable: settingsManager.isProjectTrusted(),
	});

	process.exit(0);
}
