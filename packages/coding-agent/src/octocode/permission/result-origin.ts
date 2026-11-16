import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { commandNames, SHELL_TOOLS } from "./shell.ts";
import { NETWORK } from "./provenance/network.ts";
import { URL_PATTERN } from "./provenance/keys.ts";

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export interface ResultOriginOptions {
	/**
	 * A shell result counts only when its call ran (`details.output` is set once it did; a call the permission gate
	 * refused holds Octocode's own text). Default true; false judges the command line alone.
	 */
	requireRan?: boolean;
}

/**
 * Whether the result of `toolName`, called with `input`, is text written by someone outside the user's workspace, and
 * where it came from: the label a fence header or a provenance source names. Undefined for a trusted result.
 *
 * Decided from the tool's source and what ran, never from a field the tool declares: MCP definitions come from external
 * servers. Untrusted are every `mcp__*` tool (the server's tool name), the `mcp` tool's `read` (a server's resource as it
 * wrote it; its other intents report Octocode's own state), `web`, and a shell command that ran a network program.
 * Callers add their own trust rules on top (workspace readers, subagents).
 */
export function untrustedResultOrigin(
	toolName: string,
	input: unknown,
	details: unknown,
	options: ResultOriginOptions = {},
): string | undefined {
	const args = isRecord(input) ? input : undefined;
	if (toolName === "web") {
		if (!args) return "web";
		const url = str(args.url);
		return url ? `web ${url}` : `web search "${str(args.query) ?? ""}"`;
	}
	if (isMcpToolName(toolName)) return toolName;
	if (toolName === "mcp") {
		if (!isRecord(details) || details.intent !== "read") return undefined;
		return ["mcp read", str(details.server), str(details.uri)].filter(Boolean).join(" ");
	}
	if (SHELL_TOOLS.has(toolName)) {
		if (options.requireRan !== false && (!isRecord(details) || typeof details.output !== "string")) return undefined;
		const command = str(args?.command);
		if (!command) return undefined;
		const program = commandNames(command).find((name) => NETWORK.has(name.toLowerCase()));
		if (!program) return undefined;
		return [toolName, program, command.match(URL_PATTERN)?.[0]].filter(Boolean).join(" ");
	}
	return undefined;
}
