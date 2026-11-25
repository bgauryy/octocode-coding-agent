import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import { defaultedModelNotice } from "../core/provider-composer/models.ts";

/**
 * A startup warning for a custom model whose fields (above all its context window) were assumed, for a session with no
 * terminal UI to show the notice the footer feature shows: print, json and RPC runs print startup diagnostics to stderr.
 * The interactive mode shows the notice itself.
 */
export function defaultedModelWarning(
	model: { provider: string; id: string } | undefined,
	interactive: boolean,
): AgentSessionRuntimeDiagnostic | undefined {
	if (interactive || !model) return undefined;
	const message = defaultedModelNotice(model.provider, model.id);
	return message ? { type: "warning", message } : undefined;
}
