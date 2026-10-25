import chalk from "chalk";
import { selectConfig } from "../cli/config-selector.ts";
import { APP_NAME, getAgentDir, getBundledSkillsDir } from "../config.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import { resolveExtensionFactories } from "../core/resource-loader/builtins.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { CONFIG_COMMAND_USAGE, printConfigCommandHelp } from "./help.ts";
import {
	createCommandSettingsManager,
	type PackageCommandRuntimeOptions,
	reportProjectTrustWarnings,
	reportSettingsErrors,
} from "./settings.ts";

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	let local = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "-a" || arg === "--approve") {
			projectTrustOverride = true;
		} else if (arg === "-na" || arg === "--no-approve") {
			projectTrustOverride = false;
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
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local resource config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "config command");
	const { builtinExtensions: builtins } = resolveExtensionFactories(runtimeOptions.extensionFactories);
	const builtinExtensions = [...builtins.keys()];
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const builtinSkillsDir = getBundledSkillsDir();
	const globalResolvedPaths = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
		builtinExtensions,
		builtinSkillsDir,
	}).resolve();
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				builtinExtensions,
				builtinSkillsDir,
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
