import type { TerminalCommandRequest, TerminalCommandResult } from "@octocodeai/octocode-contracts/protocol";
import type { ApplicationSession } from "./session-port.ts";

type Handler = (request: TerminalCommandRequest) => TerminalCommandResult;
const handlers = new WeakMap<ApplicationSession, Handler>();

/** Attaching an editor leaves transcript hydration lazy until an application client opens the port. */
export function registerTerminalCommands(session: ApplicationSession, handler: Handler): () => void {
	handlers.set(session, handler);
	return () => {
		if (handlers.get(session) === handler) handlers.delete(session);
	};
}

export function terminalCommandsFor(session: ApplicationSession): Handler | undefined {
	return handlers.get(session);
}
