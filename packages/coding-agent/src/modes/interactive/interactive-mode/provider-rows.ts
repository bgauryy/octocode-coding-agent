import type { ProviderEntry, ProviderSnapshot } from "../../../core/provider-view/snapshot.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { type BadgeState, badge } from "../../../theme/page-kit.ts";
import type { PageRow } from "../../../theme/manage-page.ts";

const BADGE_OF: Record<ProviderEntry["state"], BadgeState> = {
	ready: "ready",
	"needs-key": "attention",
	expired: "attention",
	paused: "attention",
	"no-models": "attention",
	orphaned: "broken",
	refused: "broken",
	disabled: "off",
};

/** The page-kit badge state of a provider. */
export const providerBadge = (entry: ProviderEntry) => badge(BADGE_OF[entry.state]);

const plural = (count: number) => `${count} ${count === 1 ? "model" : "models"}`;

/** One row: the snapshot's sentence, its next step, where it is defined and how many models it offers. */
function providerRow(entry: ProviderEntry): PageRow {
	const shown = providerBadge(entry);
	const parts = [entry.statusText];
	if (entry.nextStep && entry.state !== "disabled") parts.push(entry.nextStep.label);
	if (entry.definitionFile) parts.push(`defined in ${homeTilde(entry.definitionFile)}`);
	else if (entry.state === "ready") parts.push("defined in built-in");
	if (entry.defined && entry.state !== "needs-key") parts.push(plural(entry.models));
	return {
		id: `provider:${entry.id}`,
		name: entry.name,
		detail: parts.join(" · "),
		badge: shown.text,
		tone: shown.tone,
		keys: { e: entry.disabled ? "enable" : "disable" },
	};
}

export interface ProviderRowGroups {
	attention: PageRow[];
	ready: PageRow[];
	off: PageRow[];
	/** Badge states on screen, for the page legend. */
	states: BadgeState[];
}

/** The listed providers of a snapshot, grouped for the main page. */
export function providerRows(snapshot: ProviderSnapshot): ProviderRowGroups {
	const groups: ProviderRowGroups = { attention: [], ready: [], off: [], states: [] };
	for (const entry of snapshot.providers) {
		if (!entry.listed) continue;
		groups[entry.state === "ready" ? "ready" : entry.state === "disabled" ? "off" : "attention"].push(
			providerRow(entry),
		);
		groups.states.push(BADGE_OF[entry.state]);
	}
	return groups;
}
