import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Handles SIGINT, SIGTERM, and SIGHUP outside Windows, for the non-interactive modes. Each signal first kills tracked
 * detached children (their process groups survive a signal death of this process), then calls `onSignal` with the
 * conventional exit code (129 for SIGHUP, 130 for SIGINT, 143 for SIGTERM).
 * Returns a function that removes the handlers.
 */
const EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export function handleTerminationSignals(onSignal: (signal: NodeJS.Signals, exitCode: number) => void): () => void {
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	const removers = signals.map((signal) => {
		const handler = () => {
			killTrackedDetachedChildren();
			onSignal(signal, EXIT_CODES[signal] ?? 143);
		};
		process.on(signal, handler);
		return () => process.off(signal, handler);
	});
	return () => {
		for (const remove of removers) remove();
	};
}
