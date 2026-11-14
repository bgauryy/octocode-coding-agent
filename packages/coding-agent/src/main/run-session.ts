/**
 * A session run: parses the arguments, opens or creates the session, builds the runtime and runs the mode the
 * arguments and terminal ask for (interactive, print, JSON or RPC).
 */

import { setCapabilityOverrides } from "@octocodeai/octocode-tui";
import chalk from "chalk";
import {
	ACP_WORKER_ENV,
	envFlag,
	PERMISSION_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	SUBAGENT_ENV,
} from "../../../common/src/env.ts";
import { normalizePath } from "../../../common/src/paths.ts";
import { normalizeSessionName, parseArgs, printHelp } from "../cli/args.ts";
import { listModels } from "../cli/list-models.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "../cli/startup-ui.ts";
import { ENV_SESSION_DIR, VERSION } from "../config.ts";
import { createAgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import { exportFromFile } from "../core/export-html/index.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { restoreStdout, takeOverStdout } from "../core/output-guard.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "../core/session-cwd.ts";
import { SessionManager } from "../core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../core/settings-diagnostics.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { readSkillResourceSnapshot } from "../core/skill-resource-snapshot.ts";
import { printTimings, time } from "../core/timings.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "../modes/index.ts";
import { folderTrustResolver } from "../octocode/trust/port.ts";
import { initTheme, stopThemeWatcher } from "../theme/theme.ts";
import { isTruthyEnvFlag } from "../utils/env-flag.ts";
import { applyRunConfigurationOrExit } from "./run-configuration.ts";
import { createCliRuntimeFactory } from "./runtime-factory.ts";
import { createSessionManager, validateForkFlags, validateSessionIdFlags } from "./session-manager.ts";
import {
	isPlainRuntimeMetadataCommand,
	prepareInitialMessage,
	promptForMissingSessionCwd,
	readPipedStdin,
	reportDiagnostics,
	requirePrompt,
	resolveAppMode,
	toPrintOutputMode,
} from "./startup.ts";
import { folderTrustAsker, gateStartup, prepareAcpTrust } from "./trust-startup.ts";

interface SessionRunContext {
	/** The folder the session starts in (after `--worktree` and the like). */
	cwd: string;
	agentDir: string;
	/** `--offline` or its environment variable: no catalog refresh. */
	offlineMode: boolean;
}

export async function runSession(args: string[], { cwd, agentDir, offlineMode }: SessionRunContext): Promise<void> {
	const parsed = parseArgs(args);
	const skillSnapshotFile = process.env[SKILL_SNAPSHOT_FILE_ENV];
	const skillResourceSnapshot =
		envFlag(process.env, SUBAGENT_ENV) && skillSnapshotFile ? readSkillResourceSnapshot(skillSnapshotFile) : undefined;
	// The start mode is the process's: every session it starts and every subagent it spawns reads it from here.
	if (parsed.permissionMode) process.env[PERMISSION_ENV] = parsed.permissionMode;
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

	const folderTrust = folderTrustResolver();
	if (parsed.mode === "acp") {
		if (parsed.help) {
			printHelp();
			return;
		}
		prepareAcpTrust(parsed);
		await (await import("./acp-host.ts")).runAcpMain(args, parsed);
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

	const startupSettingsManager = SettingsManager.createForStartup(cwd, agentDir, folderTrust(cwd).state === "trusted");
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	await applyRunConfigurationOrExit(parsed, {
		cwd,
		agentDir,
		settings: startupSettingsManager,
		projectTrusted: folderTrust(cwd).state === "trusted",
	});
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
			sessionManager = await SessionManager.openAsync(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
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

	const requireTrust = !parsed.help && parsed.listModels === undefined;
	if (requireTrust)
		await gateStartup({ parsed, appMode, cwd: sessionManager.getCwd(), settingsManager: startupSettingsManager });
	if (appMode === "interactive" && requireTrust && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}
	const createRuntime = createCliRuntimeFactory({
		parsed,
		cwd,
		folderTrust,
		requireTrust,
		getAppMode: () => appMode,
		// Read before RPC mode clears it, so a session the worker switches to later still knows.
		acpWorker: envFlag(process.env, ACP_WORKER_ENV),
		skillResourceSnapshot,
	});
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	if (requireTrust) {
		// A switch into another folder is checked before the current session is torn down (resume, new session, import).
		runtime.folderAdmission.resolve = folderTrust;
		runtime.folderAdmission.ask = folderTrustAsker(() => appMode);
	}
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		printHelp();
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
		stdinContent = parsed.noStdin ? undefined : await readPipedStdin();
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
		process.exit(1);
	}
	time("createSession");

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
		await runRpcMode(runtime, {
			noDialogs: parsed.noDialogs,
			rpcAsk: parsed.rpcAsk,
			leanEvents: parsed.rpcLeanEvents,
		});
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtime, {
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
			createFolderTrustAsker: (prompt) => folderTrustAsker(() => appMode, prompt),
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
	}
}
