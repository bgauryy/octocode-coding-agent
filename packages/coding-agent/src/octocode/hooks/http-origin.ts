import { renderPrompt } from "../../core/prompt-template.ts";
import { fenceUntrusted, headerText } from "../shared/fence.ts";
import type { HookHandler, HookVerdict } from "./contracts.ts";

/**
 * What a hook that answers over HTTP may do, beyond what a local command hook may: nothing, but the answer comes from
 * another machine. Its text reaches the model inside the shared untrusted fence (see `fenceUntrusted`), and a decision
 * that opens a gate or changes a call is audited with the host that made it.
 */

/** The host of an HTTP hook's URL: never the path or query, which can carry tokens. */
const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return "unknown host";
	}
};

/** `verdict` with the text a remote server wrote (`additionalContext`, a continuation reason) marked as external data; any other hook's verdict unchanged. */
export function labelHttpVerdict(hook: HookHandler, verdict: HookVerdict): HookVerdict {
	if (hook.type !== "http" || (!verdict.context && !verdict.continueReason)) return verdict;
	const header = renderPrompt("notices/hooks/http-origin.md", { host: headerText(hostOf(hook.url), 80) });
	return {
		...verdict,
		// `context` reaches the model through `hookContext`, which fences it: only the origin line goes in front.
		...(verdict.context ? { context: `${header}:\n${verdict.context}` } : {}),
		...(verdict.continueReason ? { continueReason: fenceUntrusted(header, verdict.continueReason) } : {}),
	};
}

/** The audit note for an HTTP hook's answer that allowed a request or rewrote a tool input, naming the host; undefined for anything else. */
export function httpDecisionNote(hook: HookHandler, verdict: HookVerdict): string | undefined {
	if (hook.type !== "http") return undefined;
	const did = [
		...(verdict.permissionDecision === "allow" ? ["allowed the request"] : []),
		...(verdict.updatedInput ? ["rewrote the tool input"] : []),
	];
	return did.length ? `HTTP hook ${headerText(hostOf(hook.url), 80)} ${did.join(" and ")}` : undefined;
}
