import type { ConfigItem, DiscoverInput, DiscoverySource, ItemVendor } from "../types.ts";

/** Lists the servers of every MCP file; the host installs it, since `packages/mcp` reaches core only through the host. */
let readMcpItems: ((input: DiscoverInput) => ConfigItem[]) | undefined;

/** Installs the MCP reader; the host does so before it registers `VENDOR_MCP_SOURCES`. */
export function installMcpItemsReader(reader: (input: DiscoverInput) => ConfigItem[]): void {
	readMcpItems = reader;
}

/** The harness each MCP file origin (`McpConfigFile.origin` in `packages/mcp`) belongs to. */
const ORIGIN_VENDOR: Readonly<Record<string, ItemVendor>> = {
	octocode: "octocode",
	agents: "agents",
	mcp: "mcp-json",
	pi: "pi",
	claude: "claude",
	codex: "codex",
	cursor: "cursor",
};

/** One read of every MCP file per discovery input, shared by the vendors' slices of it. */
const read = new WeakMap<DiscoverInput, ConfigItem[]>();

/**
 * The `mcp` source of one vendor: the servers `packages/mcp` lists (`mcpItems` over `mcpConfigFiles`) whose file
 * belongs to it. The vendors are concatenated in `VENDORS` order, which keeps the loader's precedence among them.
 */
export function mcpSource(vendor: ItemVendor): DiscoverySource {
	return {
		kind: "mcp",
		discover(input) {
			let items = read.get(input);
			if (!items) {
				if (!readMcpItems)
					throw new Error("MCP discovery runs only after installOctocodeDiscovery installs its reader");
				items = readMcpItems(input);
				read.set(input, items);
			}
			return items.filter((item) => (ORIGIN_VENDOR[item.provenance.origin] ?? "octocode") === vendor);
		},
	};
}
