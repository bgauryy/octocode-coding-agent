/**
 * Fatal errors and crashes: the crash record, extension hints, the /bug suggestion after errors, and the warning
 * when the installation changed while the session ran.
 */

import { type AssistantMessage, isRetryableAssistantError } from "@octocodeai/octocode-ai/compat";
import { APP_NAME, detectInstallChange, VERSION } from "../../../config.ts";
import { findExtensionStackMatches, recordCrash as writeCrashRecord } from "../../../core/crash-log.ts";
import { killTrackedDetachedChildren } from "../../../utils/shell.ts";
import { ThemedText } from "../components/themed-text.ts";
import { stopThemeWatcher, theme } from "../../../theme/theme.ts";
import { isDeadTerminalError, formatCrashExtensionHint, formatResumeCommand } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Interactive-mode members used by crash reporting. */
type CrashReportingHost = Pick<
	InteractiveModeHost,
	| "bugReportHintShown"
	| "chatContainer"
	| "uncaughtCrash"
	| "crashReportInstructions"
	| "emergencyTerminalExit"
	| "getCrashExtensionHint"
	| "installChangeWarningShown"
	| "isShuttingDown"
	| "maybeShowInstallChangeWarning"
	| "outputPad"
	| "recordCrash"
	| "session"
	| "sessionManager"
	| "showError"
	| "showWarning"
	| "stop"
	| "suggestBugReport"
	| "ui"
	| "unregisterSignalHandlers"
>;

export async function handleFatalRuntimeError(
	host: CrashReportingHost,
	prefix: string,
	error: unknown,
): Promise<never> {
	const message = errorMessage(error);
	host.showError(`${prefix}: ${message}`);
	const extensionHint = host.getCrashExtensionHint(error);
	if (extensionHint) {
		host.chatContainer.addChild(new ThemedText(() => theme.fg("warning", extensionHint), host.outputPad, 0));
	}
	if (host.recordCrash("fatal_error", error)) {
		const instructions = host.crashReportInstructions();
		host.chatContainer.addChild(new ThemedText(() => theme.fg("muted", instructions), host.outputPad, 0));
	}
	stopThemeWatcher();
	host.stop("transcript");
	process.exit(1);
}

export function getCrashExtensionHint(host: CrashReportingHost, error: unknown): string | undefined {
	try {
		return formatCrashExtensionHint(
			findExtensionStackMatches(
				error instanceof Error ? error.stack : undefined,
				host.session.resourceLoader.getExtensions().extensions,
			),
		);
	} catch {
		return undefined;
	}
}

/** Persist a crash so the next start can point the user at `/bug`. Returns false when nothing was written. */
export function recordCrash(
	host: CrashReportingHost,
	kind: "uncaught_exception" | "fatal_error",
	error: unknown,
): boolean {
	try {
		return (
			writeCrashRecord({
				kind,
				error,
				sessionFile: host.session.sessionFile,
				cwd: host.session.sessionManager.getCwd(),
			}) !== undefined
		);
	} catch {
		return false;
	}
}

export function crashReportInstructions(host: CrashReportingHost): string {
	const resumeCommand = host.session.sessionFile ? formatResumeCommand(host.sessionManager) : undefined;
	const resume = resumeCommand ? `run \`${resumeCommand}\` to resume the session, then` : "start octocode and";
	return `To report this crash: ${resume} run /bug. The crash details are attached automatically.`;
}

export function suggestBugReport(host: CrashReportingHost): void {
	if (host.bugReportHintShown) return;
	host.bugReportHintShown = true;
	host.chatContainer.addChild(
		new ThemedText(
			() => theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`),
			host.outputPad,
			0,
		),
	);
	host.ui.requestRender();
}

export function maybeSuggestBugReport(host: CrashReportingHost, message: AssistantMessage): void {
	if (message.stopReason !== "error" || isRetryableAssistantError(message)) return;
	if (/\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i.test(message.errorMessage ?? "")) return;
	if (host.maybeShowInstallChangeWarning()) return;
	host.suggestBugReport();
}

/**
 * After an error, check whether an update replaced or removed this install while the session ran.
 * Code loaded on demand then fails with missing modules until restart (#10439). Returns true when
 * the install changed.
 */
export function maybeShowInstallChangeWarning(host: CrashReportingHost): boolean {
	if (host.installChangeWarningShown) return true;
	const change = detectInstallChange();
	if (!change) return false;
	host.installChangeWarningShown = true;
	const cause =
		change.kind === "updated"
			? `${APP_NAME} was updated to ${change.version} while this session was running (${VERSION})`
			: `The ${APP_NAME} installation this session runs from was removed or replaced`;
	const resumeCommand = formatResumeCommand(host.sessionManager);
	const restart = resumeCommand
		? `Restart with \`${resumeCommand}\` to continue this session.`
		: `Restart ${APP_NAME}.`;
	host.showWarning(`${cause}. Features that load code on demand can fail until restart. ${restart}`);
	return true;
}

export function emergencyTerminalExit(host: CrashReportingHost): never {
	host.isShuttingDown = true;
	host.unregisterSignalHandlers();
	killTrackedDetachedChildren();
	// The terminal is gone. Do not run normal shutdown because TUI and
	// extension cleanup can write restore sequences and re-trigger EIO.
	process.exit(129);
}

/** More survived errors than this within the window means something is looping: crash with the latest. */
const SURVIVED_LIMIT = 10;
const SURVIVED_WINDOW_MS = 60_000;
const survivedAt = new WeakMap<object, number[]>();

/**
 * Node 25+ reports a FileHandle its owner dropped without closing as an uncaught error, after it has already closed the
 * descriptor itself. Nothing is half-done, so the session survives it; the owner's leak is still a bug to fix.
 */
export function isLeakedFileHandleError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === "ERR_INVALID_STATE" &&
		error.message.startsWith("A FileHandle object was closed during garbage collection")
	);
}

/**
 * Process-level error listener. A rejection nobody awaited and a leaked FileHandle tear no in-memory state, so they are
 * shown as a warning and the session keeps running; any other uncaught throw may have stopped code mid-change and
 * crashes. A burst of survived errors crashes too, so a loop cannot flood the chat.
 */
export function backgroundError(
	host: CrashReportingHost,
	kind: "uncaughtException" | "unhandledRejection",
	error: unknown,
): void {
	const crash = (): never => host.uncaughtCrash(error instanceof Error ? error : new Error(errorMessage(error)));
	if (kind === "uncaughtException" && !isLeakedFileHandleError(error)) crash();
	if (host.isShuttingDown) return;
	const now = Date.now();
	const recent = [...(survivedAt.get(host) ?? []).filter((at) => now - at < SURVIVED_WINDOW_MS), now];
	survivedAt.set(host, recent);
	if (recent.length > SURVIVED_LIMIT) crash();
	try {
		const what = kind === "unhandledRejection" ? "Unhandled background error" : "Background error";
		host.showWarning(`${what}; the session keeps running: ${errorMessage(error)}`);
		host.suggestBugReport();
	} catch {
		// A warning that cannot render must not turn a survivable error into a crash.
	}
}

/**
 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
 * mode and hides the cursor; without this handler, an uncaught throw from
 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
 * tears down the process while leaving the terminal in raw mode with no
 * cursor, requiring `stty sane && reset` to recover.
 *
 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
 * paste / Kitty / modifyOtherKeys sequences.
 */
export function uncaughtCrash(host: CrashReportingHost, error: Error): never {
	// A dead terminal is not an Octocode crash. Do not try to restore it or record it.
	if (isDeadTerminalError(error)) {
		host.emergencyTerminalExit();
	}
	if (host.isShuttingDown) {
		process.exit(1);
	}
	host.isShuttingDown = true;
	// Each step is best effort: the process is exiting on a crash, and a failure in one must not skip the next or hide the crash report below.
	try {
		host.unregisterSignalHandlers();
	} catch {
		// Handlers that cannot be removed no longer matter: the process exits below.
	}
	try {
		killTrackedDetachedChildren();
	} catch {
		// A child that cannot be killed is left to the OS; the crash report matters more.
	}
	try {
		host.ui.stop();
	} catch {
		// A terminal that cannot be restored cleanly is already dead or about to be; the report prints either way.
	}
	console.error(`${APP_NAME} exiting due to uncaughtException:`);
	console.error(error);
	const extensionHint = host.getCrashExtensionHint(error);
	if (extensionHint) console.error(`\n${extensionHint}`);
	if (host.recordCrash("uncaught_exception", error)) {
		console.error(`\n${host.crashReportInstructions()}`);
	}
	process.exit(1);
}
