import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Handles SIGTERM, and SIGHUP outside Windows, for the non-interactive modes. Each signal first kills tracked detached
 * children, then calls `onSignal` with the conventional exit code (129 for SIGHUP, 143 for SIGTERM).
 * Returns a function that removes the handlers.
 */
export function handleTerminationSignals(onSignal: (signal: NodeJS.Signals, exitCode: number) => void): () => void {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const removers = signals.map((signal) => {
		const handler = () => {
			killTrackedDetachedChildren();
			onSignal(signal, signal === "SIGHUP" ? 129 : 143);
		};
		process.on(signal, handler);
		return () => process.off(signal, handler);
	});
	return () => {
		for (const remove of removers) remove();
	};
}
