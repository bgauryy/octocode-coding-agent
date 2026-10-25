import type { ExtensionAPI } from "../core/extensions/index.ts";
import type { Skill } from "../core/skills.ts";
import { octocodePromptSections } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { envFlag, READ_ONLY_ENV } from "./shared/env.ts";
import { promptRootsFromEnv, rebasePath } from "./shared/prompt-root.ts";
import { isOctocodeTool, OCTOCODE_SERVER, OCTOCODE_TOOL_PREFIX } from "../../../mcp/src/presets/octocode/names.ts";
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
		const server = getMcpSessionStatus(pi.events).find((server) => server.name === OCTOCODE_SERVER);
		// Deferred tools are reachable through discovery even before a tool is loaded.
		const indirect = selected.includes("tool_search")
			? pi
					.getAllTools()
					.filter((tool) => isOctocodeTool(tool.name) && !selected.includes(tool.name) && tool.exposure === "deferred")
			: [];
		// A server from the user's mcp.json may still be connecting when the prompt is built; the prompt says how to recover
		// when a tool turns out to be missing, so an enabled configured server counts as reachable (and the prompt stays cached).
		const octocode =
			selected.some(isOctocodeTool) ||
			indirect.length > 0 ||
			(server?.enabled === true && !["failed", "stopped", "disabled"].includes(server.state) && canReachMcp(selected));
		// Every Octocode tool this agent can call, declared or deferred: loading a deferred tool does not change the set.
		const octocodeTools = octocode
			? [...new Set([...selected.filter(isOctocodeTool), ...indirect.map((tool) => tool.name)])]
					.map((name) => name.slice(OCTOCODE_TOOL_PREFIX.length))
					.sort()
			: [];
		// A read-only role keeps `file` for its reports; its profile, not its tools, says it leaves source unchanged.
		const canWrite = !readOnlyRole && ["file", "write", "edit"].some((name) => selected.includes(name));
		const profiles = [...options.profiles().values()];
		const inputs = {
			octocode,
			profiles: profiles.map(({ name, description }) => ({ name, description })),
			browserProfiles:
				!options.isSubagent && selected.includes("agent") && !selected.includes("browser")
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
			...(octocode && octocodeTools.length > 0 ? { octocodeTools } : {}),
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

/** Whether this session can reach MCP tools at all: declared, through discovery or from scripts. */
const canReachMcp = (selected: readonly string[]): boolean =>
	selected.some((name) => name.startsWith("mcp__") || name === "tool_search");

/** Copy the skill metadata so child prompt preparation cannot mutate the loader's catalog. */
export function childSkills(skills: readonly Skill[]): Skill[] {
	return skills.map((skill) => ({ ...skill }));
}
