/**
 * What this session declares of each MCP tool and what decided it, for a settings view. The registry publishes a reader
 * (`registerMcpHost`); a process without a session (the web daemon) has none. Reading never connects a server.
 */

import type { McpExposure, McpServerEntry } from "./config.ts";
import type { ToolAudit } from "@octocodeai/octocode-contracts/config";
import type { UsageAuditSource } from "@octocodeai/octocode-common/tool-audit";
import { defersByRecentUse, defersByUsage } from "./deferral.ts";
import { isEnabled, type McpServer } from "./server.ts";
import { configuredMcpToolExposure } from "./servers.ts";
import { auditReader, sessionUsage } from "./usage-audit.ts";

/**
 * What decided a tool's state: its own `toolExposure` entry (`pin`), a `toolExposure` pattern, the server's `exposure`,
 * recent use under `mcpExposure: "recent"`, the promotion snapshot under `"usage"` (the row's `audit.reason` says
 * `promoted` or `unused`), another deferral of the session (the `mcpExposure` setting or a deferred
 * role), or nothing (`default`).
 */
/** What the Tools panel shows of an exposure: an on-demand tool reads as `deferred` there (listed, not in full). */
export const toolExposureState = (exposure: McpExposure): Exclude<McpExposure, "onDemand"> =>
	exposure === "onDemand" ? "deferred" : exposure;

type McpToolDecision = "pin" | "pattern" | "server" | "recent" | "usage" | "setting" | "default";

interface McpToolState {
	/** The tool's name as the server offers it. */
	name: string;
	state: Exclude<McpExposure, "onDemand">;
	decidedBy: McpToolDecision;
	/** What the usage record says of the tool; absent while it holds no data (and the setting is not `usage`). */
	audit?: ToolAudit;
}

export interface McpServerToolStates {
	server: string;
	/** False while the server is not connected: its tools are then unknown. */
	connected: boolean;
	/** False for a server a feature registered: its configuration is not saved. */
	saved: boolean;
	tools: McpToolState[];
}

/** What the reader needs of the feature state, so this module does not depend on it. */
interface McpToolStateSource {
	servers: readonly McpServer[];
	toolExposure(entry: McpServerEntry, tool: string): McpExposure;
	exposureSetting(): unknown;
	/** The session's in-use set: the promotion snapshot under `usage`. */
	recentTools?(): ReadonlySet<string> | undefined;
	/** The usage record; default: the session's own. */
	usage?(): UsageAuditSource | undefined;
}

function decisionOf(entry: McpServerEntry, tool: string, state: McpExposure, setting: unknown): McpToolDecision {
	const pins = entry.config.toolExposure;
	if (pins?.[tool] !== undefined) return "pin";
	if (configuredMcpToolExposure({ ...entry.config, exposure: undefined }, tool) !== undefined) return "pattern";
	const byUse = defersByUsage(setting) ? "usage" : defersByRecentUse(setting) ? "recent" : undefined;
	// The session declares something else than the configuration says: a deferral decided it.
	if (state !== (entry.config.exposure ?? "direct")) return byUse ?? "setting";
	if (entry.config.exposure !== undefined) return "server";
	return byUse ?? "default";
}

/** Every enabled server of the session with the state of each tool it offers. */
export function mcpToolStates(source: McpToolStateSource): McpServerToolStates[] {
	const setting = source.exposureSetting();
	const audit = auditReader((source.usage ?? sessionUsage)(), setting, source.recentTools?.());
	return source.servers.filter(isEnabled).map(({ entry, connection }) => {
		const connected = connection?.state === "connected";
		return {
			server: entry.name,
			connected,
			saved: entry.scope !== "feature",
			tools: (connected ? connection.tools : []).map((tool) => {
				const state = toolExposureState(source.toolExposure(entry, tool.name));
				const decidedBy = decisionOf(entry, tool.name, state, setting);
				return {
					name: tool.name,
					state,
					decidedBy,
					...(audit ? { audit: audit(entry.name, tool, state) } : {}),
				};
			}),
		};
	});
}

let reader: (() => McpServerToolStates[]) | undefined;
let serverNamesReader: (() => string[] | undefined) | undefined;

/** Sets the session's reader; the MCP registry calls it once. */
export function publishMcpToolStates(
	read: () => McpServerToolStates[],
	readServerNames?: () => string[] | undefined,
): void {
	reader = read;
	serverNamesReader = readServerNames;
}

/** All registered names, including disabled, withheld and pending entries; undefined means unavailable. */
export function currentMcpServerNames(): string[] | undefined {
	return serverNamesReader?.();
}

/** The session's tool states, or undefined in a process that runs no session. */
export function currentMcpToolStates(): McpServerToolStates[] | undefined {
	return reader?.();
}
