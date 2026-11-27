import { type ProviderQuotas, providerQuotas } from "../core/model-runtime/quota-request.ts";
import type { SessionEntry } from "../core/session-manager.ts";
import { quotaRows, readingsText } from "./shared/quota-text.ts";

/**
 * The providers this session used: those of its replies and side calls, the selected model's, and every provider this
 * process took a quota reading of (an external agent's runner included).
 */
export function sessionProviders(
	entries: readonly SessionEntry[],
	selected: string | undefined,
	quotas: Pick<ProviderQuotas, "providers"> = providerQuotas,
): string[] {
	const providers = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") providers.add(entry.message.provider);
		else if (entry.type === "usage") providers.add(entry.provider);
	}
	if (selected) providers.add(selected);
	for (const provider of quotas.providers()) providers.add(provider);
	return [...providers];
}

/**
 * `/status`'s Quota section: a heading and one line per provider with a reading in force (memory first, then what
 * other Octocode processes stored); no lines when no provider has one.
 */
export function quotaLines(
	providers: readonly string[],
	quotas: Pick<ProviderQuotas, "current" | "now"> = providerQuotas,
): string[] {
	const now = quotas.now();
	const shown = providers.flatMap((provider) => {
		const readings = quotas.current(provider);
		return readings.length > 0 ? [{ provider, text: readingsText(readings, now) }] : [];
	});
	return shown.length > 0 ? ["Quota", ...quotaRows(shown)] : [];
}
