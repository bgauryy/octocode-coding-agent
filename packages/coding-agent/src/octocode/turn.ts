import type { ExtensionAPI } from "../core/extensions/index.ts";
import type { Skill } from "../core/skills.ts";
import { currentEnvironment } from "../core/system-prompt.ts";
import { GRAPH_TOOLS } from "./graph/cli.ts";
import { leanPromptSections } from "./instructions/lean.ts";
import { octocodePromptSections } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { envFlag, LEAN_ENV, READ_ONLY_ENV, SKILLS_IN_TASK_ENV } from "./shared/env.ts";
import { promptRootsFromEnv, rebasePath } from "./shared/prompt-root.ts";
import { isOctocodeTool, OCTOCODE_SERVER } from "../../../mcp/src/presets/octocode/names.ts";
import { BROWSER_SERVER } from "../../../mcp/src/presets/browser/names.ts";
import { browserMcpTool } from "./shared/browser-mcp.ts";
import { type AgentProfile, profileSelectsTool } from "./subagents/profiles.ts";

/** Adds the cached native prompt section without changing the session's selected tools. */
export function registerTurnSetup(
	api: ExtensionAPI,
	options: {
		isSubagent: boolean;
		profiles: () => Map<string, AgentProfile>;
	},
): { reset(): void } {
	let prompt: Record<string, string> | undefined;
	let promptKey: string | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	const readOnlyRole = options.isSubagent && envFlag(process.env, READ_ONLY_ENV);
	const lean = options.isSubagent && envFlag(process.env, LEAN_ENV);
	// Skills the parent chose ride in the task (`subagents/task-skills.ts`), so the cached prompt does not depend on them.
	const skillsInTask = lean || (options.isSubagent && envFlag(process.env, SKILLS_IN_TASK_ENV));
	const promptRoots = options.isSubagent ? promptRootsFromEnv(process.env) : undefined;

	api.on("before_agent_start", async (event) => {
		const selected = event.systemPromptOptions.selectedTools ?? api.getActiveTools();
		const servers = getMcpSessionStatus(api.events);
		const server = servers.find((server) => server.name === OCTOCODE_SERVER);
		// The built-in browser server selected for this agent, declared or still connecting, means this agent can browse
		// itself. Only enablement and selection count, not connection state or the declared tools, so the delegation text
		// is the same before and after the server connects. By default only the browser subagent selects it.
		const browserServer = servers.find((server) => server.name === BROWSER_SERVER);
		const browserMcp =
			(browserServer?.enabled === true && browserServer.state !== "unselected") ||
			selected.some((name) => browserMcpTool(name) !== undefined);
		// Only enablement and selection count, never connection state: the prompt says how to recover when a tool turns
		// out to be missing, so a server that is still connecting, or that failed or stopped later, keeps the same policy
		// bytes and the cached prefix. `mcp_status` carries the state. The native `mcp` tool is always selected where MCP
		// is allowed, so the answer does not change when the server's own tools appear.
		const octocode = selected.some(isOctocodeTool) || (server?.enabled === true && canReachMcp(selected));
		// A read-only role keeps `file` for its reports; its profile, not its tools, says it leaves source unchanged.
		const canWrite = !readOnlyRole && ["file", "write", "edit"].some((name) => selected.includes(name));
		const profiles = [...options.profiles().values()];
		const inputs = {
			octocode,
			// graphBuild stays for a read-only role: the permission gate allows it because it writes only `.octocode/graph/`.
			graphTools: GRAPH_TOOLS.filter((name) => selected.includes(name)),
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
			canMcp: canReachMcp(selected),
		};
		const key = JSON.stringify(inputs);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = lean
				? leanPromptSections({ canShell: inputs.canShell, canSave: inputs.canSave, readOnly: readOnlyRole })
				: octocodePromptSections(inputs);
		}
		// A named section (not a whole-prompt override) lets Octocode record a small transcript delta. The policy and the
		// role stay session sections, after project context: the profile list and a project-defined role are project
		// specific, and project instructions keep their place after the policy.
		Object.assign(event.systemPromptOptions.sections, prompt);
		if (role !== undefined) event.systemPromptOptions.sections.role = role;
		// Checked at every prompt: a new day changes only this section.
		event.systemPromptOptions.environment = currentEnvironment();
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
			event.systemPromptOptions.skills = skillsInTask ? [] : childSkills(event.systemPromptOptions.skills ?? []);
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

/** Whether this session can reach MCP at all: the native `mcp` tool or declared server tools. */
const canReachMcp = (selected: readonly string[]): boolean =>
	selected.some((name) => name === "mcp" || name.startsWith("mcp__"));

/** Copy the skill metadata so child prompt preparation cannot mutate the loader's catalog. */
export function childSkills(skills: readonly Skill[]): Skill[] {
	return skills.map((skill) => ({ ...skill }));
}
