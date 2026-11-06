import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

/** The project root's `.mcp.json` (Claude Code's project format, which other agents read too). */
export const mcpJsonVendor: Vendor = {
	id: "mcp-json",
	label: "root .mcp.json",
	defaultOn: vendorDefaultOn("mcp-json"),
	switchable: true,
	sources: [mcpSource("mcp-json")],
};
