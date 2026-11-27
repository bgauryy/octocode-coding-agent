import type { QuotaReading } from "@octocodeai/octocode-contracts";
import { type ProviderQuotas, providerQuotas } from "../../model-runtime/quota-request.ts";

/** What the web reads of the process's quota readings (`providerQuotas`). */
export type QuotaSource = Pick<ProviderQuotas, "all" | "providers">;

/** The most readings a snapshot carries (`QuotaSchema` list bound). */
const MAX_READINGS = 64;

/** Within the contract's bounds (`QuotaReadingSchema`): outside them the whole frame would be refused. */
function fits(reading: QuotaReading): boolean {
	return (
		reading.provider.length > 0 &&
		reading.provider.length <= 128 &&
		reading.window.length > 0 &&
		reading.window.length <= 64 &&
		reading.label.length <= 128 &&
		reading.usedFraction >= 0 &&
		reading.usedFraction <= 1 &&
		Number.isFinite(reading.observedAt) &&
		(reading.resetsAt === undefined || Number.isFinite(reading.resetsAt))
	);
}

/**
 * The quota readings in force for the session's providers: those its entries name, the selected model's, and every
 * provider this process took a reading of (its subagents and external runners included), as `/status` lists them.
 * One read of the quota store, which keeps a database read for a few seconds; plan windows first within a provider.
 */
export function sessionQuota(
	providers: ReadonlySet<string>,
	selected: string | undefined,
	quotas: QuotaSource = providerQuotas,
): QuotaReading[] {
	const wanted = new Set([...providers, ...quotas.providers()]);
	if (selected) wanted.add(selected);
	if (wanted.size === 0) return [];
	const readings: QuotaReading[] = [];
	for (const reading of quotas.all()) {
		if (readings.length >= MAX_READINGS) break;
		if (!wanted.has(reading.provider) || !fits(reading)) continue;
		readings.push({
			provider: reading.provider,
			window: reading.window,
			label: reading.label,
			usedFraction: reading.usedFraction,
			...(reading.resetsAt === undefined ? {} : { resetsAt: reading.resetsAt }),
			kind: reading.kind,
			source: reading.source,
			observedAt: reading.observedAt,
		});
	}
	return readings;
}
