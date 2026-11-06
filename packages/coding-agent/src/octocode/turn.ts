import type { ExtensionAPI } from "../core/features/index.ts";
import type { Skill } from "../core/skills.ts";
import { currentEnvironment, linkedWorktreeFact } from "../core/system-prompt.ts";
import { FILE_TOOL } from "../core/tools/tool-names.ts";
import { leanPromptSections } from "./instructions/lean.ts";
import { octocodePromptSections, type ResearchContext } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { envFlag, LEAN_ENV, READ_ONLY_ENV, SKILLS_IN_TASK_ENV } from "../../../common/src/env.ts";
import { promptRootsFromEnv, rebasePath } from "./shared/prompt-root.ts";
import { AGENT_ROLE_ENV } from "./team/store/env.ts";
import { currentToolRoles } from "../../../mcp/src/roles.ts";
import { BROWSER_SERVER } from "../../../common/src/mcp-names.ts";
import { browserMcpTool } from "../../../common/src/browser-mcp.ts";
import { type AgentProfile, profileSelectsBrowser } from "./subagents/profiles.ts";

/** Adds the cached native prompt section without changing the session's selected tools. */
export function registerTurnSetup(
	api: ExtensionAPI,
	options: {
		isSubagent: boolean;
		profiles: () => Map<string, AgentProfile>;
		/** Whether the `agent` tool declares its `external` type here. */
		canExternal?: () => boolean;
	},
): { reset(): void } {
	let prompt: Record<string, string> | undefined;
	let promptKey: string | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	const readOnly = options.isSubagent && envFlag(process.env, READ_ONLY_ENV);
	const lean = options.isSubagent && envFlag(process.env, LEAN_ENV);
	// Skills the parent chose ride in the task (`subagents/task-skills.ts`), so the cached prompt does not depend on them.
	const skillsInTask = lean || (options.isSubagent && envFlag(process.env, SKILLS_IN_TASK_ENV));
	const promptRoots = options.isSubagent ? promptRootsFromEnv(process.env) : undefined;

	/** Whether a person can answer `askUser`; read once, so the cached prompt never changes during a session. */
	let hasUI: boolean | undefined;

	api.on("before_agent_start", async (event, ctx) => {
		hasUI ??= ctx.hasUI;
		const selected = event.systemPromptOptions.selectedTools ?? api.getActiveTools();
		const servers = getMcpSessionStatus(api.events);
		const roles = currentToolRoles().research;
		const server = roles && servers.find((server) => server.name === roles.server);
		// The built-in browser server selected for this agent, declared or still connecting, means this agent can browse
		// itself, so the delegation text names no browser specialist. Only enablement and selection count, not connection
		// state or the declared tools, so that text is the same before and after the server connects. By default only the
		// browser subagent selects it.
		const browserServer = servers.find((server) => server.name === BROWSER_SERVER);
		const browserMcp =
			(browserServer?.enabled === true && browserServer.state !== "unselected") ||
			selected.some((name) => browserMcpTool(name) !== undefined);
		// Only enablement and selection count, never connection state, so a server that is still connecting, or that
		// failed or stopped later, keeps the same policy bytes and the cached prefix. The `mcp_status` section carries the
		// state. The native `mcp` tool is always selected where MCP is allowed, so the answer does not change when the
		// server's own tools appear.
		const research: ResearchContext | undefined =
			roles &&
			(selected.some((name) => name.startsWith(roles.prefix)) ||
				(server?.enabled === true && server.state !== "unselected" && canReachMcp(selected)))
				? { prefix: roles.prefix, reader: roles.reader, search: roles.search }
				: undefined;
		const profiles = [...options.profiles().values()];
		// A child whose profile declares `browser.control` and that holds the browser server drives its own isolated
		// browser. Both are fixed by the profile, so every child of one profile keeps the same policy text.
		const ownProfile = options.isSubagent ? options.profiles().get(process.env[AGENT_ROLE_ENV] ?? "") : undefined;
		const browserControl = browserMcp && ownProfile?.permissions?.includes("browser.control") === true;
		const inputs = {
			research,
			profiles: profiles.map(({ name, description }) => ({ name, description })),
			browserProfiles:
				!options.isSubagent && selected.includes("agent") && !browserMcp
					? profiles.filter(profileSelectsBrowser).map(({ name }) => name)
					: [],
			canDelegate: !options.isSubagent,
			canUseAgent: selected.includes("agent"),
			canExternal: selected.includes("agent") && options.canExternal?.() === true,
			readOnly,
			// A read-only role keeps `file` for its reports; its profile, not its tools, says it leaves source unchanged.
			canSave: selected.includes(FILE_TOOL),
			canShell: selected.includes("bash") || selected.includes("powershell"),
			canWeb: selected.includes("web"),
			// What the selection allows, never what has connected: a server coming up must not change these bytes.
			canReadLocal:
				research !== undefined && (typeof api.selectsTools !== "function" || api.selectsTools(research.reader, true)),
			canAsk: selected.includes("askUser") && hasUI,
			// Availability follows the connected servers; a global MCP opt-out still applies.
			canMcp: canReachMcp(selected),
			browserControl,
		};
		const key = JSON.stringify(inputs);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = lean
				? leanPromptSections({ canShell: inputs.canShell, canSave: inputs.canSave, readOnly })
				: octocodePromptSections(inputs);
		}
		// A named section (not a whole-prompt override) lets Octocode record a small transcript delta. The policy and the
		// role stay session sections: the profile list and a project-defined role are project specific, and project
		// instructions follow the policy (`core/system-prompt-spec.ts`).
		Object.assign(event.systemPromptOptions.sections, prompt);
		if (role !== undefined) event.systemPromptOptions.sections.role = role;
		// Checked at every prompt: a new day changes only this section.
		// An isolated child's prompt names the main checkout (below), so it carries no worktree fact.
		event.systemPromptOptions.environment = currentEnvironment(
			undefined,
			undefined,
			promptRoots || !event.systemPromptOptions.cwd ? undefined : linkedWorktreeFact(event.systemPromptOptions.cwd),
		);
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
