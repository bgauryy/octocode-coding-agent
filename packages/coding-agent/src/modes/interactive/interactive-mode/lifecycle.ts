import { processLifetime } from "@octocodeai/octocode-common/process-lifetime";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { drainDbWriters } from "../../../storage/database.ts";
import { onHighlightLanguagesLoaded } from "../../../utils/syntax-highlight.ts";
/**
 * Exit, suspend and shutdown: Ctrl+C, Ctrl+D and Ctrl+Z, signal handlers, and stopping the terminal UI.
 */

import { join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { clearPromptNote, showPromptNote } from "../../../octocode/ui/prompt-note.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../theme/theme.ts";
import { foregroundChildActive } from "../../../utils/foreground-child.ts";
import { killTrackedDetachedChildren } from "../../../utils/shell.ts";
import { endIfStalled, watchMainThread } from "../../../utils/stall-guard.ts";
import { selectInterruptAt } from "../state/input-slice.ts";
import { selectInitialized, selectShutdownRequested, selectShuttingDown } from "../state/lifecycle-slice.ts";
import { isDeadTerminalError, formatResumeCommand } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { disposeLoadedResources } from "./loaded-resources.ts";
import { disposeTranscript } from "./transcript-dispose.ts";

/** Under the agent directory: one JSON line for each session ended because its main thread stayed blocked. */
const STALL_LOG = "main-thread-stalls.jsonl";

/** Interval of the timer that holds the event loop open during shutdown; it only has to exist, never fire. */
const KEEP_ALIVE_MS = 60_000;
/** How long the registered graceful releases may take after the session's own cleanup (`processLifetime.shutdown`). */
const RELEASE_MS = 2_000;

/** Interactive-mode members used by shutdown and signal handling. */
type LifecycleHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "clearEditor"
	| "clearFeatureTerminalInputListeners"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "disposeActiveSelector"
	| "backgroundError"
	| "emergencyTerminalExit"
	| "footerDataProvider"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "showStatus"
	| "shutdown"
	| "signalCleanupHandlers"
	| "stop"
	| "stopInteractiveTui"
	| "themeController"
	| "ui"
	| "uncaughtCrash"
	| "unregisterSignalHandlers"
	| "uiStore"
	| "unsubscribe"
	| "loadedResourcesContainer"
>;

/** How soon a second Ctrl+C must follow the first to exit; the prompt says so for as long. */
export const EXIT_PRESS_WINDOW_MS = 1000;

/**
 * The first Ctrl+C stops a run (a turn, a `!` command or a compaction) as Esc does and keeps the draft; with nothing
 * running it clears the prompt. Either way it says a second one exits, and a second within the window exits: a run that
 * does not stop never holds the user in.
 */
export function handleCtrlC(host: LifecycleHost): void {
	const now = Date.now();
	const state = host.uiStore.getState();
	if (now - selectInterruptAt(state) < EXIT_PRESS_WINDOW_MS) {
		clearPromptNote();
		void host.shutdown();
		return;
	}
	const { session } = host;
	// The Esc handler in force knows what is running (a compaction swaps in its own).
	if (session.isStreaming || session.isBashRunning || session.isCompacting) host.defaultEditor.onEscape?.();
	else host.clearEditor();
	state.noteInterrupt(now);
	showPromptNote(`${keyText("app.clear")} again to exit`, EXIT_PRESS_WINDOW_MS);
}

export function handleCtrlD(host: LifecycleHost): void {
	// Only called when editor is empty (enforced by CustomEditor)
	void host.shutdown();
}

/**
 * Gracefully shutdown the agent.
 * Stops the TUI before emitting shutdown events so feature UI cleanup cannot
 * repaint the final frame while the process is exiting.
 */
export async function shutdown(host: LifecycleHost, options?: { fromSignal?: boolean }): Promise<void> {
	if (!host.uiStore.getState().beginShutdown()) return;
	// Stopping the terminal UI releases the last handles that keep the event loop alive, while the dispose still waits on
	// unref'd ones (the database writer worker, the session API server, job and child handles). Without a ref'd timer Node
	// ends the process mid-dispose: exit 13 for the top-level await in `cli.ts`, and no resume hint.
	// oxlint-disable-next-line no-restricted-globals -- a process keep-alive must be ref'd; the shared clock's timer is unref'd
	const keepAlive = setInterval(() => undefined, KEEP_ALIVE_MS);
	try {
		await teardownAndExit(host, options);
	} finally {
		clearInterval(keepAlive);
	}
}

async function teardownAndExit(host: LifecycleHost, options?: { fromSignal?: boolean }): Promise<void> {
	// Keep signal handlers registered until terminal cleanup has completed.
	// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
	// dispatch and re-sends the signal if only its own listeners remain.

	if (options?.fromSignal) {
		// Signal-triggered shutdown (SIGINT/SIGTERM/SIGHUP). Emit feature cleanup
		// (session_shutdown) BEFORE touching the terminal. Feature teardown
		// such as removing sockets does not write to the tty, so it must not be
		// skipped if a later terminal-restore write fails on a dead or stalled
		// terminal. If the terminal is gone, the restore writes below emit EIO,
		// which the stdout/stderr error handler turns into an exit once this
		// dispose is done; the render loop is already idle, so this cannot hot-spin.
		await disposeOnce(host);
		await releaseAll();
		host.themeController.disableAutoSync();
		await host.ui.terminal.drainInput(1000);
		host.stop();
		await host.ui.terminal.drainOutput?.();
		await drainDbWriters();
		process.exit(0);
	}

	// Interactive quit (Ctrl+D, Ctrl+C, /quit, feature shutdown()). Stop the
	// TUI before emitting shutdown events so feature UI cleanup cannot repaint
	// the final frame while the process is exiting.
	// Drain any in-flight Kitty key release events before stopping.
	// This prevents escape sequences from leaking to the parent shell over slow SSH.
	host.themeController.disableAutoSync();
	await host.ui.terminal.drainInput(1000);

	host.stop();
	await disposeOnce(host);
	await releaseAll();

	const resumeCommand = formatResumeCommand(host.sessionManager);
	if (resumeCommand) {
		process.stdout.write(`${theme.fg("dim", "To resume this session:")} ${resumeCommand}\n`);
	}

	await host.ui.terminal.drainOutput?.();
	await drainDbWriters();
	process.exit(0);
}

/** The graceful releases still registered once the session is disposed; what is left runs at exit, synchronously. */
async function releaseAll(): Promise<void> {
	const { timedOut, failed } = await processLifetime.shutdown(RELEASE_MS);
	for (const name of timedOut) process.stderr.write(`Octocode: ${name} was not released within ${RELEASE_MS} ms.\n`);
	for (const { name, error } of failed)
		process.stderr.write(`Octocode could not release ${name}: ${errorMessage(error)}\n`);
}

/** The runtime's dispose, shared by a shutdown and a dead terminal (`onDeadTerminal`): the session is torn down once. */
const disposing = new WeakMap<object, Promise<void>>();
function disposeOnce(host: Pick<LifecycleHost, "runtimeHost">): Promise<void> {
	let done = disposing.get(host);
	if (!done) {
		done = host.runtimeHost.dispose();
		disposing.set(host, done);
	}
	return done;
}

/**
 * The terminal hung up (its window closed: SIGHUP) or was revoked, so nothing can be shown or restored on it. The work
 * this session started still stops as on SIGTERM, before the exit: subagents are told to stop (they stop their own
 * commands and report), bash jobs and MCP servers end. That dispose is the same one the signal's shutdown awaits, and
 * bounded the same way. Later write errors of the dead terminal are echoes of this one.
 */
const deadTerminals = new WeakSet<object>();
function onDeadTerminal(host: LifecycleHost): void {
	if (deadTerminals.has(host)) return;
	deadTerminals.add(host);
	host.uiStore.getState().beginShutdown();
	void disposeOnce(host)
		.catch(() => undefined)
		.finally(() => host.emergencyTerminalExit());
}

/**
 * Check if shutdown was requested and perform shutdown if so.
 */
export async function checkShutdownRequested(host: LifecycleHost): Promise<void> {
	if (!selectShutdownRequested(host.uiStore.getState())) return;
	await host.shutdown();
}

/**
 * Ctrl+Z stopped the UI: a Ctrl+C typed in the shell meanwhile (a SIGINT) must not start a shutdown. SIGTERM and SIGHUP
 * (the terminal closed) still shut a suspended session down. The same holds while a foreground child (the external
 * editor, an interactive `/octocode` subcommand) owns the terminal: its Ctrl+C is the child's.
 */
let suspended = false;
/** Set once the suspend path has sent its own group SIGTSTP: from then on a SIGTSTP stops this process. */
let stopping = false;

/**
 * An external `kill -TSTP` (a job-control tool, a parent process) runs the same suspend as the Ctrl+Z key, so the shell
 * gets the terminal back out of raw mode and the alternate screen. With a listener installed Node no longer stops on
 * SIGTSTP, so this handler stops the process itself when the stop is due: the suspend path's own group signal, or a
 * signal while a foreground child owns the terminal (the child and its terminal modes are its own, as without a listener).
 * A signal while the suspend is still draining its restore output is that same suspend: it stops the group when done.
 */
function handleSigtstp(host: Pick<LifecycleHost, "ui" | "showStatus" | "uiStore">): void {
	if (stopping || foregroundChildActive() || selectShuttingDown(host.uiStore.getState())) {
		process.kill(process.pid, "SIGSTOP");
		return;
	}
	if (suspended) return;
	handleCtrlZ(host);
}

export function registerSignalHandlers(host: LifecycleHost): void {
	host.unregisterSignalHandlers();

	// SIGINT here is an external signal (`kill -INT`, an IDE stop button): in raw mode Ctrl+C is a key, not a signal.
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
		const tstpHandler = () => handleSigtstp(host);
		process.on("SIGTSTP", tstpHandler);
		host.signalCleanupHandlers.push(() => process.off("SIGTSTP", tstpHandler));
	}

	// A main thread that stays blocked cannot answer any of these signals: the watch ends the session instead.
	host.signalCleanupHandlers.push(watchMainThread({ notePath: join(getAgentDir(), STALL_LOG) }));

	for (const signal of signals) {
		const handler = () => {
			if ((suspended || foregroundChildActive()) && signal === "SIGINT") return;
			// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
			// first, then attempts terminal restore. A genuinely dead terminal
			// surfaces as an EIO on a write, which the stdout/stderr error handler
			// turns into an exit once the same dispose has stopped the children.
			// Subagents are left to the graceful stop (report, worktree save); the exit hook kills any still running.
			killTrackedDetachedChildren({ sparingGraceful: true });
			void host.shutdown({ fromSignal: true });
		};
		process.prependListener(signal, handler);
		host.signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	const terminalErrorHandler = (error: Error) => {
		if (!isDeadTerminalError(error)) throw error;
		onDeadTerminal(host);
	};
	// stdin needs the handler too: once the terminal is gone, reads and setRawMode
	// fail with EIO (orphaned background process group) or ENOTTY (revoked tty).
	// Node emits these as stream errors, which are uncaught without a listener.
	for (const stream of [process.stdin, process.stdout, process.stderr]) {
		stream.on("error", terminalErrorHandler);
		host.signalCleanupHandlers.push(() => stream.off("error", terminalErrorHandler));
	}

	// Uncommon syntax grammars load the first time shown code names one (`syntax-highlight.ts`). Re-render (a full
	// transcript replay in regular mode) only when code already shown named a language that has just loaded. The
	// listener set is module-wide: removed with the rest, or every replaced mode would stay reachable from it.
	host.signalCleanupHandlers.push(
		onHighlightLanguagesLoaded(() => {
			if (!selectInitialized(host.uiStore.getState())) return;
			host.ui.invalidate();
			host.ui.requestRender();
		}),
	);

	// Restore the terminal before the process dies on an uncaught throw.
	// Without this, an unhandled exception from feature code (or anywhere
	// in Octocode) leaves the terminal in raw mode with no cursor.
	// backgroundError keeps the session for errors that tear no state (see crash-reporting.ts) and crashes for the rest.
	const uncaughtExceptionHandler = (error: Error) => host.backgroundError("uncaughtException", error);
	// Without a listener Node turns an unawaited rejection into an uncaught exception, ending the session.
	const unhandledRejectionHandler = (reason: unknown) => host.backgroundError("unhandledRejection", reason);
	process.prependListener("uncaughtException", uncaughtExceptionHandler);
	process.prependListener("unhandledRejection", unhandledRejectionHandler);
	host.signalCleanupHandlers.push(() => {
		process.off("uncaughtException", uncaughtExceptionHandler);
		process.off("unhandledRejection", unhandledRejectionHandler);
	});
}

export function unregisterSignalHandlers(host: LifecycleHost): void {
	for (const cleanup of host.signalCleanupHandlers) {
		cleanup();
	}
	host.signalCleanupHandlers = [];
}

export function handleCtrlZ(host: Pick<LifecycleHost, "ui" | "showStatus">): void {
	const ui = host.ui;
	if (process.platform === "win32") {
		host.showStatus("Suspend to background is not supported on Windows");
		return;
	}

	// Keep the event loop alive while suspended. Without this, stopping the TUI
	// can leave Node with no ref'ed handles, causing the process to exit on fg
	// before the SIGCONT handler gets a chance to restore the terminal.
	// oxlint-disable-next-line no-restricted-globals -- a process keep-alive must be ref'd; the shared clock's timer is unref'd
	const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

	// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
	// kill the backgrounded process. The handler is removed on resume.
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);

	const onResume = () => {
		suspended = false;
		stopping = false;
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		ui.start();
		ui.requestRender(true);
	};
	process.once("SIGCONT", onResume);
	const recover = () => {
		suspended = false;
		stopping = false;
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		process.removeListener("SIGCONT", onResume);
	};
	// Only the terminal's foreground group stops: this process and the children that share its group and terminal. The
	// detached children (subagents, bash commands and background jobs) run in sessions of their own with no controlling
	// terminal, so they keep running: one stopped mid-transaction would hold the shared database's write lock for as
	// long as this session stays suspended, and a job never reads the terminal it does not have.
	const suspend = () => {
		if (!suspended) return;
		stopping = true;
		process.kill(0, "SIGTSTP");
	};

	try {
		// Stop the TUI (restore terminal to normal mode). A suspend is not an exit: the fullscreen UI leaves the
		// alternate screen without writing the transcript into the shell, and enters it again on resume.
		suspended = true;
		ui.stop({ preserveScreen: ui.mode === "fullscreen" });

		// Let queued terminal restore sequences reach the shell before stopping this process group.
		const draining = ui.terminal?.drainOutput?.();
		if (draining)
			void draining.then(suspend).catch((error: unknown) => {
				recover();
				void Promise.reject(error);
			});
		else suspend();
	} catch (error) {
		recover();
		throw error;
	}
}

export function stop(host: LifecycleHost, fullscreenExitOutput = host.settingsManager.getFullscreenExitOutput()): void {
	// The process-wide signal, stream-error and uncaught handlers go whatever a disposer below throws.
	try {
		host.disposeActiveSelector();
		if (host.settingsManager.getShowTerminalProgress()) {
			host.ui.terminal.setProgress(false);
		}
		host.clearStatusIndicator();
		host.themeController.disableAutoSync();
		host.clearFeatureTerminalInputListeners();
		host.footerDataProvider.dispose();
		disposeLoadedResources(host.loadedResourcesContainer);
		if (host.unsubscribe) {
			host.unsubscribe();
		}
		const lifecycle = host.uiStore.getState();
		if (selectInitialized(lifecycle)) {
			// Leaving raw mode waits for the terminal to read pending output; one that stopped reading must not hold the exit.
			endIfStalled(() => host.stopInteractiveTui(fullscreenExitOutput));
			lifecycle.setInitialized(false);
		}
		// Final transcript output still needs live rows; release their clocks only after the renderer stops.
		disposeTranscript(host.chatContainer);
	} finally {
		host.unregisterSignalHandlers();
	}
}
