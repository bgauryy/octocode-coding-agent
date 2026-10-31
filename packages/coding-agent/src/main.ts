import { readSkillResourceSnapshot } from "./core/skill-resource-snapshot.ts";
import { envFlag, SKILL_SNAPSHOT_FILE_ENV, SUBAGENT_ENV } from "../../common/src/env.ts";
import { runCompletionCommand } from "./cli/completion.ts";
/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { setCapabilityOverrides } from "@octocodeai/octocode-tui";
import chalk from "chalk";
import { normalizeSessionName, parseArgs, printHelp, restoreBooleanFlagWords } from "./cli/args.ts";
import { listModels } from "./cli/list-models.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "./cli/startup-ui.ts";
import { APP_NAME, ENV_SESSION_DIR, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import type { AppMode } from "./core/project-trust.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "./core/session-cwd.ts";
import { SessionManager } from "./core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { loadMcpCommand } from "../../mcp/src/cli.lazy.ts";
import { runAuthCommand } from "./main/auth-command.ts";
import { runModelDiscoveryCommand } from "./main/model-discovery.ts";
import { startupCwd } from "./cli/worktree-startup.ts";
import { createCliRuntimeFactory } from "./main/runtime-factory.ts";
import { createSessionManager, validateForkFlags, validateSessionIdFlags } from "./main/session-manager.ts";
import {
	EXTENSION_LOAD_FAILURE_HINT,
	isPlainRuntimeMetadataCommand,
	prepareInitialMessage,
	promptForMissingSessionCwd,
	readPipedStdin,
	reportDiagnostics,
	requirePrompt,
	resolveAppMode,
	toPrintOutputMode,
} from "./main/startup.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "./theme/theme.ts";
import { validateThemeJson } from "./theme/theme-schema.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isTruthyEnvFlag } from "./utils/env-flag.ts";
import { normalizePath } from "../../common/src/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

export { createSessionManager } from "./main/session-manager.ts";

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	if (runCompletionCommand(args)) return;
	resetTimings();
	// Commands and startup selectors can load user-authored themes before runtime creation.
	setThemeJsonValidator(validateThemeJson);
	const extensionFactories = options?.extensionFactories ?? [];
	if (args[0] === "migrate") {
		if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
			console.log(
				`Usage: ${APP_NAME} migrate\nConvert historical configuration in ${getAgentDir()} and .octocode/ in the current directory. Pi fallback directories are read-only and are not migrated.`,
			);
			return;
		}
		if (args.length !== 1) {
			console.error(`Usage: ${APP_NAME} migrate`);
			process.exitCode = 1;
			return;
		}
		const result = runMigrations(process.cwd());
		if (result.migratedAuthProviders.length > 0) {
			console.log(`Migrated credentials for: ${result.migratedAuthProviders.join(", ")}`);
		}
		showDeprecationWarnings(result.deprecationWarnings);
		console.log(`Migration checks completed for ${getAgentDir()} and the current project's .octocode/.`);
		return;
	}
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.OCTOCODE_OFFLINE);
	if (offlineMode) {
		process.env.OCTOCODE_OFFLINE = "1";
		process.env.OCTOCODE_SKIP_VERSION_CHECK = "1";
	}

	if (await runAuthCommand(args)) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();
	const cwd = await startupCwd(args);
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();
	if (await runModelDiscoveryCommand(args)) return;

	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `octocode update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}

	if (args[0] === "mcp") {
		const { runMcpCommand } = await loadMcpCommand();
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		return;
	}

	if (args[0] === "context") {
		const { runContextCommand } = await import("./octocode/context-optimization/command.ts");
		process.exitCode = await runContextCommand(args.slice(1), { agentDir, cwd });
		return;
	}

	const parsed = parseArgs(args);
	const skillSnapshotFile = process.env[SKILL_SNAPSHOT_FILE_ENV];
	const skillResourceSnapshot =
		envFlag(process.env, SUBAGENT_ENV) && skillSnapshotFile ? readSkillResourceSnapshot(skillSnapshotFile) : undefined;
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.mode === "acp") {
		if (parsed.help) {
			printHelp();
			return;
		}
		if (options?.extensionFactories?.length)
			throw new Error(
				"ACP workers require file-based extensions; inline extension factories cannot cross process boundaries.",
			);
		const { acpWorkerArguments, runAcpMode } = await import("../../acp/src/server/acp-mode.ts");
		await runAcpMode(acpWorkerArguments(args, parsed));
		return;
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	const startupSettingsManager = SettingsManager.createForStartup(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? normalizePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const trustStore = new ProjectTrustStore(agentDir);
	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const createRuntime = createCliRuntimeFactory({
		parsed,
		cwd,
		trustStore,
		startupSettingsManager,
		trustPromptMode,
		getAppMode: () => appMode,
		skillResourceSnapshot,
		extensionFactories,
	});
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	const extensionFlags = resourceLoader
		.getExtensions()
		.extensions.flatMap((extension) => Array.from(extension.flags.values()));
	// A word an unknown `--flag` consumed belongs to the prompt when that flag turns out to be boolean.
	restoreBooleanFlagWords(parsed, (name) =>
		extensionFlags.some((flag) => flag.name === name && flag.type === "boolean"),
	);
	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
	time("prepareInitialMessage");
	requirePrompt(appMode, initialMessage, parsed);
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	time("resolveModelScope");
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage("cli")));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.OCTOCODE_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: OCTOCODE_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	if (!offlineMode && appMode === "rpc") {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtime, {
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			// Give the TUI's stdin handler a brief chance to consume terminal query replies
			// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
			await new Promise((resolve) => setTimeout(resolve, 150));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
