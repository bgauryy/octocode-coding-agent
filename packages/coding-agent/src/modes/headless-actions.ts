import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionCommandContextActions } from "../core/features/index.ts";

/**
 * The command actions print and RPC modes share: each acts on the session bound when it runs, read through
 * `getSession`, since a rebind replaces the session.
 */
export function headlessCommandActions(
	getSession: () => AgentSession,
): Pick<ExtensionCommandContextActions, "waitForIdle" | "navigateTree" | "reload"> {
	return {
		waitForIdle: () => getSession().waitForIdle(),
		navigateTree: async (targetId, options) => {
			const result = await getSession().navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		reload: async () => {
			await getSession().reload();
		},
	};
}
