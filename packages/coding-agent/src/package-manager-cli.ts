import { join } from "node:path";
import { cliStyle } from "./utils/cli-style.ts";
import { APP_NAME, detectInstallMethod, getAgentDir, getSelfUpdateCommand, PACKAGE_NAME, VERSION } from "./config.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { getPackageCommandUsage, printPackageCommandHelp } from "./package-manager-cli/help.ts";
import { getActiveManagedInstallRoot, runManagedSelfUpdate } from "./package-manager-cli/managed-install.ts";
import {
	parsePackageCommand,
	updateTargetIncludesPackages,
	updateTargetIncludesSelf,
} from "./package-manager-cli/parse.ts";
import {
	getSelfUpdatePlan,
	prepareWindowsNpmSelfUpdate,
	printPnpmSelfUpdateMetadataHint,
	printSelfUpdateFallback,
	printSelfUpdateNote,
	printSelfUpdateUnavailable,
	runSelfUpdate,
} from "./package-manager-cli/self-update.ts";
import {
	createCommandSettingsManager,
	FOLDER_NOT_TRUSTED_HINT,
	reportProjectTrustWarnings,
	reportSettingsErrors,
} from "./package-manager-cli/settings.ts";

export { handleConfigCommand } from "./package-manager-cli/config-command.ts";
export { cleanupManagedInstall } from "./package-manager-cli/managed-install.ts";

async function refreshModelCatalogs(agentDir: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) {
			throw new Error("Model catalog refresh timed out.");
		}
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(`Could not refresh model catalogs: ${details}`);
		}
	} finally {
		clearTimeout(timeout);
	}
	console.log(cliStyle.success("Model catalogs refreshed"));
}

export async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(cliStyle.error(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(cliStyle.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(cliStyle.error(`Missing value for ${options.missingOptionValue}.`));
		console.error(cliStyle.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(cliStyle.error(`Unexpected argument ${options.invalidArgument}.`));
		console.error(cliStyle.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(cliStyle.error(options.conflictingOptions));
		console.error(cliStyle.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(cliStyle.error(`Missing ${options.command} source.`));
		console.error(cliStyle.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.command === "update" && options.updateTarget?.type === "models") {
		try {
			await refreshModelCatalogs(getAgentDir());
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown model catalog refresh error";
			console.error(cliStyle.error(`Error: ${message}`));
			process.exitCode = 1;
		}
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = createCommandSettingsManager({
		cwd,
		agentDir,
		trust: options.trust,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(cliStyle.error(`${FOLDER_NOT_TRUSTED_HINT} Project package config was not changed.`));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(cliStyle.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(cliStyle.success(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(cliStyle.error(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(cliStyle.success(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(cliStyle.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(cliStyle.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(cliStyle.heading("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(cliStyle.heading("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "self" };
				if (options.showPackagesSkippedNote) {
					console.log(cliStyle.dim(`Packages are skipped. Run ${APP_NAME} update --packages to update packages.`));
				}
				if (updateTargetIncludesPackages(target)) {
					const updateSource = target.type === "packages" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(cliStyle.success(`Updated ${updateSource}`));
					} else {
						console.log(cliStyle.success("Updated packages"));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					const managedInstallRoot = getActiveManagedInstallRoot();
					if (managedInstallRoot && options.force) {
						console.error(
							cliStyle.error(
								`Managed ${APP_NAME} installations do not support --force; rerun the installer to repair this installation.`,
							),
						);
						process.exitCode = 1;
						return true;
					}
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						return true;
					}
					if (managedInstallRoot) {
						if (selfUpdatePlan.note) {
							printSelfUpdateNote(selfUpdatePlan.note);
						}
						try {
							console.log(cliStyle.dim(`Updating managed ${APP_NAME} installation...`));
							await runManagedSelfUpdate(managedInstallRoot, selfUpdatePlan.version);
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : "Unknown managed update error";
							console.error(cliStyle.error(`Error: ${message}`));
							process.exitCode = 1;
							return true;
						}
						console.log(cliStyle.success(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
						return true;
					}

					const installMethod = detectInstallMethod();
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						console.error(
							cliStyle.error(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`),
						);
						console.error(cliStyle.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
						process.exitCode = 1;
						return true;
					}
					const selfUpdateTarget = {
						packageName: selfUpdatePlan.packageName,
						installSpec: selfUpdatePlan.installSpec,
					};
					const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, selfUpdateNpmCommand, selfUpdateTarget);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdateTarget);
						process.exitCode = 1;
						return true;
					}
					if (selfUpdatePlan.note) {
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					try {
						if (installMethod === "npm") {
							prepareWindowsNpmSelfUpdate();
						}
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown package command error";
						console.error(cliStyle.error(`Error: ${message}`));
						if (installMethod === "pnpm") {
							printPnpmSelfUpdateMetadataHint();
						}
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					console.log(cliStyle.success(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(cliStyle.error(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
