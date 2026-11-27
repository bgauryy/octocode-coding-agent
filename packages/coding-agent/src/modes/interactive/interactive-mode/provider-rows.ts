import type { ProviderEntry, ProviderSnapshot } from "../../../core/provider-view/snapshot.ts";
import { plural } from "@octocodeai/octocode-common/clip";
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

/**
 * One row: the snapshot's sentence, its next step, where it is defined and how many models it offers. An Available
 * row (`badged` false) carries no badge and no sentence: a built-in nobody set up needs no action, only a next step.
 */
function providerRow(entry: ProviderEntry, badged: boolean): PageRow {
	const shown = badged ? providerBadge(entry) : undefined;
	// An Available row needs a key by definition (the group says so): only its next step is news.
	const parts = !badged && entry.nextStep ? [] : [entry.statusText];
	if (entry.nextStep && entry.state !== "disabled") parts.push(entry.nextStep.label);
	// A key kept in the definition file already names it: the path, which wraps on a narrow page, shows once.
	const file = entry.definitionFile ? homeTilde(entry.definitionFile) : undefined;
	if (file) parts.push(entry.statusText.endsWith(` in ${file}`) ? "defined there" : `defined in ${file}`);
	else if (entry.state === "ready") parts.push("defined in built-in");
	if (entry.defined && entry.state !== "needs-key") parts.push(plural(entry.models, "model"));
	return {
		id: `provider:${entry.id}`,
		name: entry.name,
		detail: parts.join(" · "),
		badge: shown?.text,
		tone: shown?.tone,
		keys: { e: entry.disabled ? "enable" : "disable" },
	};
}

export interface ProviderRowGroups {
	attention: PageRow[];
	ready: PageRow[];
	/** Built-in providers with no credential and no definition yet: open one to sign in or add a key. */
	available: PageRow[];
	off: PageRow[];
	/** Badge states on screen, for the page legend. */
	states: BadgeState[];
}

/** Every provider of a snapshot, grouped for the main page; the unlisted ones are the Available group. */
export function providerRows(snapshot: ProviderSnapshot): ProviderRowGroups {
	const groups: ProviderRowGroups = { attention: [], ready: [], available: [], off: [], states: [] };
	for (const entry of snapshot.providers) {
		const group = !entry.listed
			? "available"
			: entry.state === "ready"
				? "ready"
				: entry.state === "disabled"
					? "off"
					: "attention";
		groups[group].push(providerRow(entry, group !== "available"));
		if (group !== "available") groups.states.push(BADGE_OF[entry.state]);
	}
	return groups;
}
