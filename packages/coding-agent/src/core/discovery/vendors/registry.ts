import type { ConfigItem, DiscoverySource, ItemVendor } from "../types.ts";
import { agentsVendor } from "./agents.ts";
import { claudeVendor } from "./claude.ts";
import { codexVendor } from "./codex.ts";
import { cursorVendor } from "./cursor.ts";
import { mcpJsonVendor } from "./mcp-json.ts";
import { octocodeVendor } from "./octocode.ts";
import { piVendor } from "./pi.ts";
import { vendorItemOn } from "./switch.ts";
import type { Vendor, VendorId } from "./types.ts";

// `ItemVendor` (discovery types) and `VendorId` (the vendor contract) must name the same harnesses.
const sameVendors: [VendorId, ItemVendor] extends [ItemVendor, VendorId] ? true : never = true;
void sameVendors;

/**
 * Tag every item with its harness and mark it `switched-off` when the harness is off, except the kinds the harness
 * loads regardless (`alwaysOn`). An item already not loaded for another reason keeps that reason.
 */
function gated(vendor: Vendor, source: DiscoverySource): DiscoverySource {
	const alwaysOn = new Set(vendor.alwaysOn);
	return {
		kind: source.kind,
		discover(input) {
			return source.discover(input).map((found): ConfigItem => {
				const item = { ...found, provenance: { ...found.provenance, vendor: vendor.id } };
				if (item.provenance.notLoaded || alwaysOn.has(item.kind) || vendorItemOn(item, input.toggles)) return item;
				return { ...item, loaded: false, provenance: { ...item.provenance, notLoaded: "switched-off" } };
			});
		},
	};
}

/** Every harness, in precedence order: an earlier harness's skill wins over a later one's of the same name. */
export const VENDORS: readonly Vendor[] = [
	octocodeVendor,
	agentsVendor,
	mcpJsonVendor,
	piVendor,
	claudeVendor,
	codexVendor,
	cursorVendor,
].map((vendor) => ({ ...vendor, sources: vendor.sources.map((source) => gated(vendor, source)) }));

/**
 * The sources the discovery service owns: every vendor's, except MCP. MCP files come from `packages/mcp`, whose path port
 * the host installs, so the host registers those (`VENDOR_MCP_SOURCES`) with the kinds it owns.
 */
export const VENDOR_SOURCES: readonly DiscoverySource[] = VENDORS.flatMap((vendor) =>
	vendor.sources.filter((source) => source.kind !== "mcp"),
);
export const VENDOR_MCP_SOURCES: readonly DiscoverySource[] = VENDORS.flatMap((vendor) =>
	vendor.sources.filter((source) => source.kind === "mcp"),
);
