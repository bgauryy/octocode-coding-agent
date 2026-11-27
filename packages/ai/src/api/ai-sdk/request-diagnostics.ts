import type { JsonObject } from "../../types/json.ts";
import { appendAssistantMessageDiagnostic, type AssistantMessageDiagnostic } from "../../utils/diagnostics.ts";

/**
 * Notices a request mapping finds while it builds the request (a cache downgrade, a capped marker count). They join
 * the reply's `diagnostics` when its stream ends, once per type for the request, and not at all when none arose.
 */
export interface RequestDiagnostics {
	/**
	 * Notes `type` for this request. With `onceKey`, a notice about a lasting setting (a host's cache tiers) is noted only
	 * the first time this process sees that key, not on every reply.
	 */
	report(type: string, details: JsonObject, onceKey?: string): void;
	/** Appends what was reported to the reply and clears it. */
	flush(output: { diagnostics?: AssistantMessageDiagnostic[] }): void;
}

/** The once key of a model: the same id behind another host or provider is another setup. */
export function modelKey(model: { provider: string; baseUrl?: string; id: string }): string {
	return `${model.provider}\u0000${model.baseUrl ?? ""}\u0000${model.id}`;
}

/** Keys of once-per-process notices already noted. One per model and notice type: bounded by the models a process uses. */
const reportedOnce = new Set<string>();

export function requestDiagnostics(): RequestDiagnostics {
	const pending = new Map<string, AssistantMessageDiagnostic>();
	return {
		report(type, details, onceKey) {
			if (pending.has(type)) return;
			if (onceKey !== undefined) {
				const key = `${type}\u0000${onceKey}`;
				if (reportedOnce.has(key)) return;
				reportedOnce.add(key);
			}
			pending.set(type, { type, timestamp: Date.now(), details });
		},
		flush(output) {
			for (const diagnostic of pending.values()) appendAssistantMessageDiagnostic(output, diagnostic);
			pending.clear();
		},
	};
}
