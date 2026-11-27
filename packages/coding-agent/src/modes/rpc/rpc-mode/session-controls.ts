import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import type { CommandActions } from "../../../core/features/index.ts";

/** ACP chooses transcript identity through its broker; ordinary RPC feature controls remain available. */
export function createSessionControls(
	runtime: AgentSessionRuntime,
	acpOwnsSession: boolean,
): Pick<CommandActions, "newSession" | "fork" | "switchSession"> {
	const assertSelection = () => {
		if (acpOwnsSession) throw new Error("ACP owns session selection. Use session/new, session/load or session/resume.");
	};
	return {
		newSession: async (options) => {
			assertSelection();
			return runtime.newSession(options);
		},
		fork: async (entryId, options) => {
			assertSelection();
			const result = await runtime.fork(entryId, options);
			return { cancelled: result.cancelled };
		},
		switchSession: async (path, options) => {
			assertSelection();
			return runtime.switchSession(path, options);
		},
	};
}
