/**
 * Exit, suspend and shutdown: Ctrl+C, Ctrl+D and Ctrl+Z, signal handlers, and stopping the terminal UI.
 */

import chalk from "chalk";
import { foregroundChildActive } from "../../../utils/foreground-child.ts";
import { killTrackedDetachedChildren } from "../../../utils/shell.ts";
import { isDeadTerminalError, formatResumeCommand } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { disposeLoadedResources } from "./loaded-resources.ts";

/** Interactive-mode members used by shutdown and signal handling. */
type LifecycleHost = Pick<
	InteractiveModeHost,
	| "clearEditor"
	| "clearExtensionTerminalInputListeners"
	| "clearStatusIndicator"
	| "disposeActiveSelector"
	| "emergencyTerminalExit"
	| "footerDataProvider"
	| "isInitialized"
	| "isShuttingDown"
	| "lastSigintTime"
	| "runtimeHost"
	| "sessionManager"
	| "settingsManager"
	| "showStatus"
	| "shutdown"
	| "shutdownRequested"
	| "signalCleanupHandlers"
	| "stop"
	| "stopInteractiveTui"
	| "themeController"
	| "ui"
	| "uncaughtCrash"
	| "unregisterSignalHandlers"
	| "unsubscribe"
	| "loadedResourcesContainer"
>;

export function handleCtrlC(host: LifecycleHost): void {
	const now = Date.now();
	if (now - host.lastSigintTime < 500) {
		void host.shutdown();
	} else {
		host.clearEditor();
		host.lastSigintTime = now;
	}
}

export function handleCtrlD(host: LifecycleHost): void {
	// Only called when editor is empty (enforced by CustomEditor)
	void host.shutdown();
}

/**
 * Gracefully shutdown the agent.
 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
 * repaint the final frame while the process is exiting.
 */
export async function shutdown(host: LifecycleHost, options?: { fromSignal?: boolean }): Promise<void> {
	if (host.isShuttingDown) return;
	host.isShuttingDown = true;
	// Keep signal handlers registered until terminal cleanup has completed.
	// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
	// dispatch and re-sends the signal if only its own listeners remain.

	if (options?.fromSignal) {
		// Signal-triggered shutdown (SIGINT/SIGTERM/SIGHUP). Emit extension cleanup
		// (session_shutdown) BEFORE touching the terminal. Extension teardown
		// such as removing sockets does not write to the tty, so it must not be
		// skipped if a later terminal-restore write fails on a dead or stalled
		// terminal. If the terminal is gone, the restore writes below emit EIO,
		// which the stdout/stderr error handler turns into emergencyTerminalExit;
		// the render loop is already idle, so this cannot hot-spin (see #4144).
		await host.runtimeHost.dispose();
		host.themeController.disableAutoSync();
		await host.ui.terminal.drainInput(1000);
		host.stop();
		process.exit(0);
	}

	// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
	// TUI before emitting shutdown events so extension UI cleanup cannot repaint
	// the final frame while the process is exiting.
	// Drain any in-flight Kitty key release events before stopping.
	// This prevents escape sequences from leaking to the parent shell over slow SSH.
	host.themeController.disableAutoSync();
	await host.ui.terminal.drainInput(1000);

	host.stop();
	await host.runtimeHost.dispose();

	const resumeCommand = formatResumeCommand(host.sessionManager);
	if (resumeCommand) {
		process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
	}

	process.exit(0);
}

/**
 * Check if shutdown was requested and perform shutdown if so.
 */
export async function checkShutdownRequested(host: LifecycleHost): Promise<void> {
	if (!host.shutdownRequested) return;
	await host.shutdown();
}

/**
 * Ctrl+Z stopped the UI: a Ctrl+C typed in the shell meanwhile (a SIGINT) must not start a shutdown. SIGTERM and SIGHUP
 * (the terminal closed) still shut a suspended session down. The same holds while a foreground child (the external
 * editor, an interactive `/octocode` subcommand) owns the terminal: its Ctrl+C is the child's.
 */
let suspended = false;

export function registerSignalHandlers(host: LifecycleHost): void {
	host.unregisterSignalHandlers();

	// SIGINT here is an external signal (`kill -INT`, an IDE stop button): in raw mode Ctrl+C is a key, not a signal.
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	for (const signal of signals) {
		const handler = () => {
			if ((suspended || foregroundChildActive()) && signal === "SIGINT") return;
			// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
			// first, then attempts terminal restore. A genuinely dead terminal
			// surfaces as an EIO on the restore writes, which the stdout/stderr
			// error handler converts into emergencyTerminalExit (see #4144, #5080).
			// Subagents are left to the graceful stop (report, worktree save); the exit hook kills any still running.
			killTrackedDetachedChildren({ sparingGraceful: true });
			void host.shutdown({ fromSignal: true });
		};
		process.prependListener(signal, handler);
		host.signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	const terminalErrorHandler = (error: Error) => {
		if (isDeadTerminalError(error)) {
			host.emergencyTerminalExit();
		}
		throw error;
	};
	// stdin needs the handler too: once the terminal is gone, reads and setRawMode
	// fail with EIO (orphaned background process group) or ENOTTY (revoked tty).
	// Node emits these as stream errors, which are uncaught without a listener.
	for (const stream of [process.stdin, process.stdout, process.stderr]) {
		stream.on("error", terminalErrorHandler);
		host.signalCleanupHandlers.push(() => stream.off("error", terminalErrorHandler));
	}

	// Restore the terminal before the process dies on any uncaught throw.
	// Without this, an unhandled exception from extension code (or anywhere
	// in Octocode) leaves the terminal in raw mode with no cursor.
	const uncaughtExceptionHandler = (error: Error) => host.uncaughtCrash(error);
	process.prependListener("uncaughtException", uncaughtExceptionHandler);
	host.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
}

export function unregisterSignalHandlers(host: LifecycleHost): void {
	for (const cleanup of host.signalCleanupHandlers) {
		cleanup();
	}
	host.signalCleanupHandlers = [];
}

export function handleCtrlZ(host: LifecycleHost): void {
	if (process.platform === "win32") {
		host.showStatus("Suspend to background is not supported on Windows");
		return;
	}

	// Keep the event loop alive while suspended. Without this, stopping the TUI
	// can leave Node with no ref'ed handles, causing the process to exit on fg
	// before the SIGCONT handler gets a chance to restore the terminal.
	const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

	// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
	// kill the backgrounded process. The handler is removed on resume.
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);

	// Set up handler to restore TUI when resumed
	const onResume = () => {
		suspended = false;
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		host.ui.start();
		host.ui.requestRender(true);
	};
	process.once("SIGCONT", onResume);

	try {
		// Stop the TUI (restore terminal to normal mode). A suspend is not an exit: the fullscreen UI leaves the
		// alternate screen without writing the transcript into the shell, and enters it again on resume.
		suspended = true;
		host.ui.stop({ preserveScreen: host.ui.mode === "fullscreen" });

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	} catch (error) {
		suspended = false;
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		// Never suspended: a later SIGCONT must not restart the TUI.
		process.removeListener("SIGCONT", onResume);
		throw error;
	}
}

export function stop(host: LifecycleHost, fullscreenExitOutput = host.settingsManager.getFullscreenExitOutput()): void {
	host.disposeActiveSelector();
	if (host.settingsManager.getShowTerminalProgress()) {
		host.ui.terminal.setProgress(false);
	}
	host.clearStatusIndicator();
	host.themeController.disableAutoSync();
	host.clearExtensionTerminalInputListeners();
	host.footerDataProvider.dispose();
	disposeLoadedResources(host.loadedResourcesContainer);
	if (host.unsubscribe) {
		host.unsubscribe();
	}
	if (host.isInitialized) {
		host.stopInteractiveTui(fullscreenExitOutput);
		host.isInitialized = false;
	}
	host.unregisterSignalHandlers();
}
