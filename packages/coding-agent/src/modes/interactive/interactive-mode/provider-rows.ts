import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { providerAccessLabel } from "../../../core/provider-label.ts";
import type { PageRow } from "../../../theme/manage-page.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { CredentialState } from "../../../core/provider-composer/credential-state.ts";
import { credentialSourceLabel } from "../../../core/provider-composer/types.ts";

type Runtime = Pick<
	ModelRuntime,
	| "getProviders"
	| "getProvider"
	| "getProviderKind"
	| "getProviderAuthStatus"
	| "hasConfiguredAuth"
	| "getAvailableSnapshot"
	| "getPlanDisabledReason"
>;

/** Configuration is local evidence; only an explicit credential check proves access. */
export function providerRows(
	runtime: Runtime,
	disabledProviders: readonly string[],
	saved: readonly CredentialInfo[],
	refused: ReadonlySet<string>,
	/** Providers whose saved credential is expired; every other provider shows connected or not set. */
	states: ReadonlyMap<string, CredentialState> = new Map(),
) {
	const disabledIds = new Set(disabledProviders);
	const counts = new Map<string, number>();
	for (const model of runtime.getAvailableSnapshot()) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	const groups: { configured: PageRow[]; attention: PageRow[]; disabled: PageRow[] } = {
		configured: [],
		attention: [],
		disabled: [],
	};
	const ids = new Set([
		...runtime.getProviders().map((provider) => provider.id),
		...saved.map((entry) => entry.providerId),
	]);
	const nameOf = (id: string) => runtime.getProvider(id)?.name ?? id;
	for (const id of [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
		const disabled = disabledIds.has(id);
		const configured = runtime.getProviderAuthStatus(id).configured;
		const stored = saved.some((entry) => entry.providerId === id);
		if (!disabled && !runtime.hasConfiguredAuth(id) && !stored) continue;
		const defined = runtime.getProvider(id) !== undefined;
		const count = counts.get(id) ?? 0;
		const paused = runtime.getPlanDisabledReason(id);
		const expired = states.get(id) === "expired";
		const needsAttention = !defined || !configured || expired || paused !== undefined || count === 0;
		const state = !defined
			? "saved credential · provider definition missing"
			: refused.has(id)
				? "Claude subscription token refused; use Claude Code in External agents"
				: paused
					? `plan paused: ${paused}`
					: expired
						? `expired · ${credentialSourceLabel(runtime.getProviderAuthStatus(id))} · sign in again`
						: configured
							? `${providerAccessLabel(runtime, id)} · ${credentialSourceLabel(runtime.getProviderAuthStatus(id))}`
							: "not set; reconnect or remove it";
		const row: PageRow = {
			id: `provider:${id}`,
			name: nameOf(id),
			detail: `${state} · ${count} ${count === 1 ? "model" : "models"}`,
			badge: disabled
				? "disabled"
				: !defined || refused.has(id)
					? "unavailable"
					: expired
						? "expired"
						: !configured
							? "not set"
							: paused
								? "paused"
								: count === 0
									? "no models"
									: "connected",
			tone: !disabled && needsAttention ? "warning" : "muted",
		};
		groups[disabled ? "disabled" : needsAttention ? "attention" : "configured"].push(row);
	}
	return groups;
}
