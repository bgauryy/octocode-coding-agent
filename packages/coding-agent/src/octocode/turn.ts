import type { ExtensionAPI } from "../core/extensions/index.ts";
import type { Skill } from "../core/skills.ts";
import { GRAPH_TOOLS } from "./graph/cli.ts";
import { octocodePromptSections } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { envFlag, READ_ONLY_ENV } from "./shared/env.ts";
import { promptRootsFromEnv, rebasePath } from "./shared/prompt-root.ts";
import { isOctocodeTool, OCTOCODE_SERVER } from "../../../mcp/src/presets/octocode/names.ts";
import { BROWSER_SERVER } from "../../../mcp/src/presets/browser/names.ts";
import { browserMcpTool } from "./shared/browser-mcp.ts";
import { type AgentProfile, profileSelectsTool } from "./subagents/profiles.ts";
import { AGENT_COLLABORATE_ENV } from "./team/store/env.ts";

/** Adds the cached native prompt section without changing the session's selected tools. */
export function registerTurnSetup(
	pi: ExtensionAPI,
	options: {
		isSubagent: boolean;
		profiles: () => Map<string, AgentProfile>;
	},
): { reset(): void } {
	let prompt: Record<string, string> | undefined;
	let promptKey: string | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	const readOnlyRole = options.isSubagent && envFlag(process.env, READ_ONLY_ENV);
	const promptRoots = options.isSubagent ? promptRootsFromEnv(process.env) : undefined;

	pi.on("before_agent_start", async (event) => {
		const selected = event.systemPromptOptions.selectedTools ?? pi.getActiveTools();
		const servers = getMcpSessionStatus(pi.events);
		const server = servers.find((server) => server.name === OCTOCODE_SERVER);
		// The built-in browser server, declared, deferred or still connecting, means this agent can browse itself. Only
		// enablement counts, not connection state or the declared tools, so the delegation text is the same before and
		// after the server connects.
		const browserServer = servers.find((server) => server.name === BROWSER_SERVER);
		const browserMcp = browserServer?.enabled === true || selected.some((name) => browserMcpTool(name) !== undefined);
		// Deferred tools are reachable through discovery even before a tool is loaded.
		const indirect = selected.includes("tool_search")
			? pi
					.getAllTools()
					.filter((tool) => isOctocodeTool(tool.name) && !selected.includes(tool.name) && tool.exposure === "deferred")
			: [];
		// A server may still be connecting when the prompt is built; the prompt says how to recover when a tool turns out to
		// be missing, so an enabled server that has not failed counts as reachable. The native `mcp` tool is always selected
		// where MCP is allowed, so the answer does not change when the server's own tools appear.
		const octocode =
			selected.some(isOctocodeTool) ||
			indirect.length > 0 ||
			(server?.enabled === true && !["failed", "stopped", "disabled"].includes(server.state) && canReachMcp(selected));
		// A read-only role keeps `file` for its reports; its profile, not its tools, says it leaves source unchanged.
		const canWrite = !readOnlyRole && ["file", "write", "edit"].some((name) => selected.includes(name));
		const profiles = [...options.profiles().values()];
		const inputs = {
			octocode,
			// graphBuild stays for a read-only role: the permission gate allows it because it writes only `.octocode/graph/`.
			graphTools: GRAPH_TOOLS.filter(
				(name) =>
					selected.includes(name) ||
					(selected.includes("tool_search") &&
						pi.getAllTools().some((tool) => tool.name === name && tool.exposure === "deferred")),
			),
			profiles: profiles.map(({ name, description }) => ({ name, description })),
			browserProfiles:
				!options.isSubagent && selected.includes("agent") && !selected.includes("browser") && !browserMcp
					? profiles.filter((profile) => profileSelectsTool(profile, "browser", [])).map(({ name }) => name)
					: [],
			canDelegate: !options.isSubagent,
			canUseAgent: selected.includes("agent"),
			canWrite,
			readOnlyRole,
			canSave: ["file", "write", "edit"].some((name) => selected.includes(name)),
			canShell: selected.includes("bash") || selected.includes("powershell"),
			canWeb: selected.includes("web"),
			// Availability follows the connected servers; a global MCP opt-out still applies.
			canMcp: selected.some((name) => name.startsWith("mcp__") || name === "mcp" || name === "tool_search"),
			// Subagent-only, and the same for every child of one run mode: nothing per-child may enter the prompt.
			...(options.isSubagent && envFlag(process.env, AGENT_COLLABORATE_ENV) ? { collaborate: true } : {}),
		};
		const key = JSON.stringify(inputs);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = octocodePromptSections(inputs);
		}
		// A named section (not a whole-prompt override) lets Octocode record a small transcript delta.
		Object.assign(event.systemPromptOptions.sections, prompt);
		if (role !== undefined) event.systemPromptOptions.sections.role = role;
		if (promptRoots) {
			// An isolated child's prompt names the main checkout, so siblings share the cached prefix. Tools and
			// permissions keep the real worktree cwd; the task text names it.
			event.systemPromptOptions.cwd = rebasePath(event.systemPromptOptions.cwd, promptRoots);
			event.systemPromptOptions.contextFiles = event.systemPromptOptions.contextFiles.map((file) => ({
				...file,
				path: rebasePath(file.path, promptRoots),
			}));
		}
		if (options.isSubagent) {
			// Keep skill routing metadata; task-specific bodies are read only when needed.
			event.systemPromptOptions.sections.docs = "";
			event.systemPromptOptions.skills = childSkills(event.systemPromptOptions.skills ?? []);
		}
		return undefined;
	});

	return {
		reset() {
			prompt = undefined;
			promptKey = undefined;
		},
	};
}

/** Whether this session can reach MCP at all: the native `mcp` tool, declared server tools or discovery. */
const canReachMcp = (selected: readonly string[]): boolean =>
	selected.some((name) => name === "mcp" || name === "tool_search" || name.startsWith("mcp__"));

/** Copy the skill metadata so child prompt preparation cannot mutate the loader's catalog. */
export function childSkills(skills: readonly Skill[]): Skill[] {
	return skills.map((skill) => ({ ...skill }));
}
