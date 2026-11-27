import { getApplicationPort } from "../../../core/application/index.ts";
import { parseContextSize } from "../../../utils/token-count.ts";
import type { InteractiveModeHost } from "./host.ts";

type Host = Pick<InteractiveModeHost, "session" | "showSelectorDialog" | "showStatus" | "showWarning" | "ui">;

export { parseContextSize } from "../../../utils/token-count.ts";

/** Returns false for the read-only report commands. */
export async function handleContextSize(host: Host, args: string): Promise<boolean> {
	if (!args || args === "all") return false;
	const session = host.session;
	const port = getApplicationPort(session);
	let tokens: number | undefined;
	if (args === "size") {
		const sessionId = session.sessionManager.getSessionId();
		const selectedModel = session.model;
		const capacity = port.invoke("getContextWindowLimit");
		if (!capacity) throw new Error("Select a physical model with /model before choosing its context size.");
		const sizes = [8192, 16000, 32000, 64000, 128000, 200000, 256000, 512000, 1_000_000].filter(
			(size) => size < capacity,
		);
		const full = `Full model capacity — ${capacity.toLocaleString()} tokens`;
		const labels = [full, ...sizes.map((size) => `${size.toLocaleString()} tokens`)];
		const selection = await host.showSelectorDialog("Context budget for this session (custom: /context 32k)", labels);
		if (!selection) return true;
		if (
			host.session !== session ||
			session.sessionManager.getSessionId() !== sessionId ||
			session.model !== selectedModel
		) {
			throw new Error("Model or session changed while choosing context size. Reopen /context size.");
		}
		tokens = selection === full ? capacity : sizes[labels.indexOf(selection) - 1];
	} else if (args === "full") {
		tokens = port.invoke("getContextWindowLimit");
		if (!tokens) throw new Error("Select a physical model with /model before choosing its context size.");
	} else if (args !== "reset") {
		tokens = parseContextSize(args);
		if (tokens === undefined) {
			host.showWarning("Usage: /context [all|size|reset|full|<tokens>]. Examples: /context 32k, /context 128000.");
			return true;
		}
	}
	const applied = port.invoke("setContextWindow", tokens);
	const scope = tokens === undefined ? "the default working context" : "for this model in this session";
	host.showStatus(
		`Context budget: ${applied.toLocaleString()} tokens, ${scope}. Automatic compaction uses this budget. /context reset restores the default; /context full uses the whole capacity.`,
	);
	host.ui.requestRender();
	return true;
}
