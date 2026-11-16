/**
 * The usage audit of MCP tools (`common/src/tool-audit.ts`): the record of the session's role group, and what deferring
 * a tool saves per request, taken from the declaration code itself (`createMcpToolDefinition`).
 */

import { join } from "node:path";
import type { ToolAudit, ToolExposureState } from "@octocodeai/octocode-contracts/config";
import { hasUsageData, readUsageAudit, toolAudit, type UsageAuditSource } from "@octocodeai/octocode-common/tool-audit";
import { USAGE_FILE_NAME, usageGroupOf } from "@octocodeai/octocode-common/usage-counts";
import type { Tool } from "./client/index.ts";
import { defersByUsage, recentToolKey } from "./deferral.ts";
import { hostPaths } from "./host.ts";
import { firstSentence, thinParameters } from "./presentation/declaration.ts";
import { toParameters } from "./tools.ts";

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * Bytes a thin declaration saves per request over the full one: the description with the server's result schema and
 * the whole input schema, minus the first sentence and the thin parameters.
 */
function deferralSavings(tool: Pick<Tool, "name" | "title" | "description" | "inputSchema" | "outputSchema">): number {
	const description = tool.description?.trim() || tool.title || tool.name;
	const parameters = toParameters(tool.inputSchema ?? {});
	const full = tool.outputSchema
		? `${description}\n\nServer result schema:\n${JSON.stringify(tool.outputSchema)}`
		: description;
	return Math.max(
		0,
		bytes({ description: full, parameters }) -
			bytes({ description: firstSentence(description), parameters: thinParameters(parameters) }),
	);
}

/** The session's own record (agent directory, role group); undefined where no host paths exist. */
export function sessionUsage(): UsageAuditSource | undefined {
	try {
		return readUsageAudit(join(hostPaths().agentDir(), USAGE_FILE_NAME), usageGroupOf());
	} catch {
		return undefined;
	}
}

/**
 * Builds a tool's audit from the record. Under `mcpExposure: "usage"` the audit is always given and names the reason a
 * tool is direct (`promoted`) or deferred (`unused`); under another setting only once the record holds data.
 */
export function auditReader(
	usage: UsageAuditSource | undefined,
	setting: unknown,
	recent: ReadonlySet<string> | undefined,
): ((server: string, tool: Tool, state: ToolExposureState) => ToolAudit) | undefined {
	const byUsage = defersByUsage(setting);
	if (!usage || (!byUsage && !hasUsageData(usage))) return undefined;
	return (server, tool, state) => {
		const key = recentToolKey(server, tool.name);
		return toolAudit(usage, key, state, {
			saved: deferralSavings(tool),
			...(byUsage ? { promoted: recent?.has(key) === true } : {}),
		});
	};
}
