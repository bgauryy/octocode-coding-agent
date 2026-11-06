import { existsSync } from "node:fs";
import { configDiscovery } from "../service.ts";
import type { ConfigItem, ConfigKind, DiscoverInput } from "../types.ts";
import { VENDORS } from "./registry.ts";
import { vendorOn } from "./switch.ts";
import type { HarnessStatus, VendorId } from "./types.ts";

let cache: { key: string; statuses: HarnessStatus[] } | undefined;

/** An item that exists as configuration: an MCP control-only override or a hook file nobody wrote is not counted. */
const counts = (item: ConfigItem): boolean =>
	item.role !== "override" && (item.kind !== "hook" || existsSync(item.provenance.path));

/**
 * Each harness with whether it is on and what it supplies: `found` counts every item per kind (shadowed, switched off or
 * untrusted included), `loaded` the ones that load now. One discovery pass, kept until the inputs change or a reload
 * starts a new discovery pass. `on` reads the switch as this workspace sees it (a project key first); `projectOnly` marks a harness only a project key switches on.
 */
export function harnessStatuses(input: DiscoverInput): HarnessStatus[] {
	const key = JSON.stringify([
		configDiscovery.generation,
		input.cwd,
		input.agentDir,
		input.projectTrusted,
		input.toggles ?? {},
		input.home,
		input.piRoots,
		input.contextRoot ?? null,
		input.plugins ?? null,
		input.includeUntrusted ?? false,
		input.env ?? process.env,
	]);
	if (cache?.key === key) return cache.statuses;
	const statuses = new Map<VendorId, HarnessStatus>(
		VENDORS.map((vendor) => [
			vendor.id,
			{
				id: vendor.id,
				label: vendor.label,
				on: vendorOn(vendor.id, input.toggles, true),
				...(vendorOn(vendor.id, input.toggles, true) && !vendorOn(vendor.id, input.toggles, false)
					? { projectOnly: true }
					: {}),
				defaultOn: vendor.defaultOn,
				switchable: vendor.switchable,
				found: {},
				loaded: {},
			},
		]),
	);
	const add = (record: Partial<Record<ConfigKind, number>>, kind: ConfigKind) => {
		record[kind] = (record[kind] ?? 0) + 1;
	};
	for (const [kind, items] of configDiscovery.discoverAll(input))
		for (const item of items) {
			const status = statuses.get(item.provenance.vendor);
			if (!status || !counts(item)) continue;
			add(status.found, kind);
			if (item.loaded) add(status.loaded, kind);
		}
	cache = { key, statuses: [...statuses.values()] };
	return cache.statuses;
}
