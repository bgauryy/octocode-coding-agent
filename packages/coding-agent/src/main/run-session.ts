/**
 * A session run: parses the arguments, opens or creates the session, builds the runtime and runs the mode the
 * arguments and terminal ask for (interactive, print, JSON or RPC).
 */

import { setCapabilityOverrides } from "@octocodeai/octocode-tui";
import { cliStyle } from "../utils/cli-style.ts";
import {
	ACP_WORKER_ENV,
	envFlag,
	MCP_DESKTOP_ENV,
	PERMISSION_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	SUBAGENT_ENV,
} from "@octocodeai/octocode-common/env";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import { normalizeSessionName, parseArgs, printHelp } from "../cli/args.ts";
import { listModels } from "../cli/list-models.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "../cli/startup-ui.ts";
import { ENV_SESSION_DIR, VERSION } from "../config.ts";
import { prepareAgentDb } from "../storage/database.ts";
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
import { drainStdio } from "./drain-stdio.ts";
import { applyRunConfigurationOrExit } from "./run-configuration.ts";
import type { NativeFeatureSet } from "../core/resource-loader/types.ts";
import { createCliRuntimeFactory } from "./runtime-factory.ts";
import { createSessionManager, validateForkFlags, validateSessionIdFlags } from "./session-manager.ts";
import {
	type AppMode,
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

/** How long an outage may hold a print-mode run when `retry.offlineMaxMs` is unset. */
const PRINT_OFFLINE_MAX_MS = 30 * 60_000;

interface SessionRunContext {
	/** The folder the session starts in (after `--worktree` and the like). */
	cwd: string;
	agentDir: string;
	/** `--offline` or its environment variable: no catalog refresh. */
	offlineMode: boolean;
	/** The native feature set every session of this run registers. */
	nativeFeatures: NativeFeatureSet;
}

/**
 * Desktop control asks the user before every start. A print or JSON run has nobody to ask, so it has no desktop server
 * and no desktop specialist, and the subagents it starts inherit that (RPC and ACP runs have a person or a client that
 * answers, and keep both).
 */
function withoutDesktopWhenNobodyCanAnswer(mode: AppMode): void {
	if (mode === "print" || mode === "json") process.env[MCP_DESKTOP_ENV] = "0";
}

export async function runSession(
	args: string[],
	{ cwd, agentDir, offlineMode, nativeFeatures }: SessionRunContext,
): Promise<void> {
	const parsed = parseArgs(args);
	const skillSnapshotFile = process.env[SKILL_SNAPSHOT_FILE_ENV];
	const skillResourceSnapshot =
		envFlag(process.env, SUBAGENT_ENV) && skillSnapshotFile ? readSkillResourceSnapshot(skillSnapshotFile) : undefined;
	// The start mode is the process's: every session it starts and every subagent it spawns reads it from here.
	if (parsed.permissionMode) process.env[PERMISSION_ENV] = parsed.permissionMode;
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? cliStyle.error : cliStyle.warn;
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
		await prepareAgentDb();
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
			console.error(cliStyle.error(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	withoutDesktopWhenNobodyCanAnswer(appMode);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(cliStyle.error("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);
	if (!isPlainRuntimeMetadataCommand(parsed)) await prepareAgentDb();

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
			console.error(cliStyle.error(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(cliStyle.error("Error: --name requires a non-empty value"));
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
		nativeFeatures,
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
	// A print run has no one to press Esc: an outage holds it only so long, unless the user set a limit.
	if (appMode !== "interactive" && appMode !== "rpc" && settingsManager.getRetrySettings().offlineMaxMs === undefined) {
		settingsManager.applyOverrides({ retry: { offlineMaxMs: PRINT_OFFLINE_MAX_MS } });
	}
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
			withoutDesktopWhenNobodyCanAnswer(appMode);
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
		console.error(cliStyle.error(formatNoModelsAvailableMessage("cli")));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.OCTOCODE_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(cliStyle.error("Error: OCTOCODE_STARTUP_BENCHMARK only supports interactive mode"));
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
			await drainStdio();
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
