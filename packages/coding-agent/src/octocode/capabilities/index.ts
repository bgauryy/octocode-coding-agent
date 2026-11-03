/**
 * Registers usage recording and installs the MCP `usage` port (`packages/mcp/src/host.ts`), which serves the day's
 * frozen snapshot (`daySnapshot`). With `mcpContractTiers: "off"` nothing is recorded or read. A database failure only
 * leaves the tiers on their cold-start defaults: it never blocks a tool call or a prompt.
 */

import type { ExtensionAPI } from "../../core/features/index.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { registeredWorkspace } from "../../config/workspace-database.ts";
import { installMcpHost } from "../../../../mcp/src/host.ts";
import { daySnapshot, localDay, UsageRecorder, usageScope } from "./usage.ts";

export interface CapabilityUsageOptions {
	isSubagent: boolean;
	/** A subagent's profile name (`AGENT_ROLE_ENV`). */
	role?: string;
	now?: () => Date;
}

export function registerCapabilityUsage(api: ExtensionAPI, options: CapabilityUsageOptions): void {
	const scope = usageScope(options.role, options.isSubagent);
	const now = options.now ?? (() => new Date());
	const enabled = () => api.getSettings().mcpContractTiers !== "off";
	const workspaces = new Map<string, string>();
	const workspaceOf = (cwd: string) => {
		let id = workspaces.get(cwd);
		if (id === undefined) {
			id = registeredWorkspace(cwd, sharedAgentDb()).id;
			workspaces.set(cwd, id);
		}
		return id;
	};
	const recorder = new UsageRecorder();

	installMcpHost({
		usage: {
			contractUsage(cwd) {
				if (!enabled()) return undefined;
				try {
					return daySnapshot(sharedAgentDb(), workspaceOf(cwd), scope, localDay(now()));
				} catch {
					return undefined;
				}
			},
		},
	});

	api.on("session_start", () => {
		recorder.reset();
	});

	// Only the model's own calls count: a call another tool made says nothing about which contracts the model reads.
	api.on("tool_result", (event, ctx) => {
		if (event.parentToolCallId || !enabled()) return undefined;
		try {
			recorder.record(sharedAgentDb(), workspaceOf(ctx.cwd), scope, localDay(now()), event.toolName);
		} catch {
			// Usage is advisory; a busy or unavailable database leaves this call uncounted.
		}
		return undefined;
	});
}
