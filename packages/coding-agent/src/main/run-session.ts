/**
 * A session run: parses the arguments, opens or creates the session, builds the runtime and runs the mode the
 * arguments and terminal ask for (interactive, print, JSON or RPC).
 */

import { captureConsoleToLog } from "./console-capture.ts";
import { exitOnNoInput } from "./no-input-exit.ts";
import { setCapabilityOverrides } from "@octocodeai/octocode-tui";
import { cliStyle } from "../utils/cli-style.ts";
import {
	ACP_WORKER_ENV,
	envFlag,
	PERMISSION_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	SUBAGENT_ENV,
} from "@octocodeai/octocode-common/env";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import { normalizeSessionName, parseArgs, printHelp } from "../cli/args.ts";
import { listModels } from "../cli/list-models.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, withStartupTuiScope } from "../cli/startup-ui.ts";
import { ENV_SESSION_DIR, VERSION } from "../config.ts";
import { prepareAgentDb } from "../storage/database.ts";
import { createAgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { isCommandLine } from "../core/agent-session/prompt-expansion.ts";
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
import { runPrintMode } from "../modes/print-mode.ts";
import { runRpcMode } from "../modes/rpc/rpc-mode.ts";
import { folderTrustResolver } from "../octocode/trust/port.ts";
import { initTheme, stopThemeWatcher } from "../theme/theme.ts";
import { isTruthyEnvFlag } from "../utils/env-flag.ts";
import { drainStdio } from "./drain-stdio.ts";
import {
	guideSignInFromShell,
	onceInstalledCrashHandlers,
	withoutDesktopWhenNobodyCanAnswer,
} from "./headless-guards.ts";
import { applyRunConfigurationOrExit } from "./run-configuration.ts";
import type { NativeFeatureSet } from "../core/resource-loader/types.ts";
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

export function runSession(args: string[], context: SessionRunContext): Promise<void> {
	return exitOnNoInput(() => runSessionUnguarded(args, context));
}

async function runSessionUnguarded(
	args: string[],
	{ cwd, agentDir, offlineMode, nativeFeatures }: SessionRunContext,
): Promise<void> {
	const crashHandlers = onceInstalledCrashHandlers();
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
		crashHandlers.install();
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
	// Before the database, settings and runtime are set up, so a crash in any of them is one line and exit 1.
	if (appMode !== "interactive") crashHandlers.install();
	withoutDesktopWhenNobodyCanAnswer(appMode);
	guideSignInFromShell(appMode);
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
	const requireTrust = !parsed.help && parsed.listModels === undefined;
	const gate = (folder: string) =>
		gateStartup({ parsed, appMode, cwd: folder, settingsManager: startupSettingsManager });
	// A new, continued or forked session runs in `cwd`, so the gate goes first and a refused run writes nothing there.
	// `--session` and `--resume` open a saved session whose folder is known only once it is open.
	// Share one StartupTui across sequential startup prompts (trust, resume, missing-cwd, first-time setup).
	const gated = requireTrust && parsed.session === undefined && !parsed.resume ? cwd : undefined;
	const sessionManager = await withStartupTuiScope(async () => {
		if (gated) await gate(gated);
		let manager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
		const missingSessionCwdIssue = getMissingSessionCwdIssue(manager, cwd);
		if (missingSessionCwdIssue) {
			if (appMode === "interactive") {
				const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
				if (!selectedCwd) {
					process.exit(0);
				}
				manager = await SessionManager.openAsync(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
			} else {
				console.error(cliStyle.error(new MissingSessionCwdError(missingSessionCwdIssue).message));
				process.exit(1);
			}
		}
		if (requireTrust && manager.getCwd() !== gated) await gate(manager.getCwd());
		if (parsed.name !== undefined) {
			const name = normalizeSessionName(parsed.name);
			if (name === undefined) {
				console.error(cliStyle.error("Error: --name requires a non-empty value"));
				process.exit(1);
			}
			manager.appendSessionInfo(name);
		}
		time("createSessionManager");

		if (appMode === "interactive" && requireTrust && shouldRunFirstTimeSetup()) {
			await showFirstTimeSetup(startupSettingsManager);
			time("firstTimeSetup");
		}
		return manager;
	});
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
		// What the terminal shows at startup about models.json (an unknown field, a provider with no credential) explains
		// a provider missing from the list.
		reportDiagnostics(deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]));
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		// An unknown or unconnected provider filter exits 1, as `listModels` reports it.
		process.exit(
			await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000), {
				provider: parsed.provider,
				size: parsed.modelSize,
				checkAccess: parsed.checkModelAccess,
			}),
		);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = parsed.noStdin ? undefined : await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
			withoutDesktopWhenNobodyCanAnswer(appMode);
			guideSignInFromShell(appMode);
		}
	}
	time("readPipedStdin");
	// Piped input turns an interactive start into print mode.
	if (appMode !== "interactive") crashHandlers.install();

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

	// RPC starts without a model: a client can set one, and a prompt is refused as `authRequired` so it can route to sign-in.
	// A headless run of commands only (`-p "/backlog"`) needs none: each command answers or says why it cannot.
	const prompts = [initialMessage, ...parsed.messages].filter((text) => text !== undefined);
	const commandsOnly = prompts.every((text) => isCommandLine(session.featureHost, text));
	if ((appMode === "print" || appMode === "json") && !session.model && !commandsOnly) {
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
		// Loaded only here: print, RPC and subagent processes never evaluate the terminal UI's modules (the Mermaid
		// renderer alone builds an ICU segmenter as it loads, about 11 ms).
		const { InteractiveMode } = await import("../modes/interactive/interactive-mode.ts");
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
		const restoreConsole = captureConsoleToLog();
		try {
			await interactiveMode.run();
		} finally {
			restoreConsole();
		}
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
