import type { ListenerErrorReporter } from "@octocodeai/octocode-agent-core";
import type { FeatureError } from "./features/types.ts";

/** What receives the reports: a session's feature runner, whose `onError` listeners each mode binds. */
interface DiagnosticsTarget {
	emitError(error: FeatureError): void;
	/** False when no mode bound an error listener (an SDK session): the report then goes to stderr instead of nowhere. */
	hasErrorListeners?(): boolean;
}

/**
 * A reporter for the agent library's contained failures (an event listener, a tool update listener or an event-bus
 * handler that threw), routed to the app's diagnostics: the session's feature error channel, which the terminal shows
 * in the chat, print mode writes to stderr and RPC sends as `extension_error`. Raw stderr text would be drawn over the
 * terminal UI. Before a session has a runner, or when nothing listens to its errors, the line goes to stderr. `source` names the reporter in the report.
 */
export function listenerErrorReporter(
	target: () => DiagnosticsTarget | undefined,
	source: "agent" | "event bus",
): ListenerErrorReporter {
	return (message, error) => {
		const runner = target();
		if (!runner || runner.hasErrorListeners?.() === false) {
			process.stderr.write(`${message}\n`);
			return;
		}
		const stack = error instanceof Error ? error.stack : undefined;
		runner.emitError({ source, event: "listener_error", error: message, ...(stack ? { stack } : {}) });
	};
}
