import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Where the model reads a declared MCP tool's contract (its description and schemas), per tool: `resident` in the
 * cached `mcps` block of every request, `indexed` on demand (the block names the tool on one line; `mcp` intent tools
 * or a failed call's hint returns the contract). `auto` lets the planner choose from recorded usage. Every declared
 * tool stays declared either way, so the tool list never changes with the tier. The tier is fixed when the prompt first
 * describes the server (`McpPresentation.describe`), and its inputs change only at session start: usage comes from a
 * snapshot frozen per workspace, scope and day (`ContractUsage`), so a warm cache never sees a tier change.
 */
export const MCP_CONTRACT_TIERS = ["auto", "resident", "indexed"] as const;
export type McpContractTier = (typeof MCP_CONTRACT_TIERS)[number];
export type ResolvedContractTier = Exclude<McpContractTier, "auto">;

/** The `mcpContractTiers` setting: `off` makes every `auto` contract resident (the behavior before tiers). */
export type McpContractTiersSetting = "auto" | "off";

/** A server whose whole contract is smaller than this stays resident: indexing it saves too little to cost a lookup. */
export const SMALL_CONTRACT_CHARS = 4_000;
/** Sessions with tool calls the usage window needs before it decides; fewer start from the cold-start defaults. */
export const MIN_USAGE_SESSIONS = 5;

/**
 * What recorded usage says, from one frozen snapshot (the host's `usage` port): how many sessions the window holds and
 * which registered tool names are resident by usage. The host owns the window and the hysteresis.
 */
export interface ContractUsage {
	sessions: number;
	resident: ReadonlySet<string>;
}

export const isMcpContractTier = (value: unknown): value is McpContractTier =>
	MCP_CONTRACT_TIERS.some((tier) => tier === value);

const tierError = (): string => `must be one of ${MCP_CONTRACT_TIERS.map((tier) => `"${tier}"`).join(", ")}`;

/** The error for a server's `contract` or `toolContract`, or undefined when both are valid or absent. */
export function contractConfigError(name: string, contract: unknown, toolContract: unknown): string | undefined {
	if (contract !== undefined && !isMcpContractTier(contract)) return `server "${name}": contract ${tierError()}`;
	if (toolContract === undefined) return undefined;
	if (!isRecord(toolContract)) return `server "${name}": toolContract must map tool names to contract tiers`;
	for (const [tool, tier] of Object.entries(toolContract))
		if (!isMcpContractTier(tier)) return `server "${name}": toolContract "${tool}" ${tierError()}`;
	return undefined;
}

export interface ContractTierInput {
	/** The tool's configured tier (`getMcpToolContract`). */
	configured: McpContractTier;
	/** The tool as the server names it, for the preset's cold-start list. */
	tool: string;
	/** The name the model calls it by, which usage is recorded under. */
	registered: string;
	/** The length of the server's whole contract with every declared tool resident. */
	serverContractChars: number;
	/** The preset's tools that start resident before usage is known; undefined: every tool starts resident. */
	coreTools?: ReadonlySet<string>;
	usage: ContractUsage | undefined;
	setting: McpContractTiersSetting;
}

/**
 * The tier of one tool. A configured `resident` or `indexed` wins. `auto` is resident when tiers are off or the server's
 * contract is small; else usage decides once the window holds enough sessions; else the cold start: the preset's core
 * tools are resident and its others indexed, and a server without a core list stays resident.
 */
export function contractTier(input: ContractTierInput): ResolvedContractTier {
	if (input.configured !== "auto") return input.configured;
	if (input.setting === "off" || input.serverContractChars < SMALL_CONTRACT_CHARS) return "resident";
	if (input.usage && input.usage.sessions >= MIN_USAGE_SESSIONS)
		return input.usage.resident.has(input.registered) ? "resident" : "indexed";
	if (!input.coreTools) return "resident";
	return input.coreTools.has(input.tool) ? "resident" : "indexed";
}

/** Shares at or above this make a tool resident; one already resident stays until it falls below `KEEP_SHARE`. */
export const PROMOTE_SHARE = 0.2;
export const KEEP_SHARE = 0.1;

/**
 * The day's resident set from session shares (sessions that called a tool / sessions with tool calls) and the previous
 * snapshot's resident set: hysteresis keeps a tool that dips a little from flipping tiers between days, so the cached
 * block changes only when usage really moved. Sorted, so equal inputs give an equal list.
 */
export function residentByUsage(
	shares: ReadonlyMap<string, number>,
	previous: ReadonlySet<string> = new Set(),
): string[] {
	return [...shares]
		.filter(([name, share]) => share >= PROMOTE_SHARE || (previous.has(name) && share >= KEEP_SHARE))
		.map(([name]) => name)
		.sort();
}
