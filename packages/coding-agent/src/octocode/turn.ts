import type { ExtensionAPI, ExtensionContext } from "../core/features/index.ts";
import type { Skill } from "../core/skills.ts";
import {
	currentEnvironment,
	type EnvironmentSurface,
	linkedWorktreeFact,
	type SessionSurface,
} from "../core/system-prompt.ts";
import { terminalHostFacts } from "@octocodeai/octocode-common/terminal-host";
import { FILE_TOOL } from "../core/tools/tool-names.ts";
import { leanPromptSections } from "./instructions/lean.ts";
import { octocodePromptSections, type ResearchContext } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import { getMcpSessionStatus, currentToolRoles } from "../../../mcp/src/api.ts";
import { envFlag, LEAN_ENV, READ_ONLY_ENV, SKILLS_IN_TASK_ENV } from "@octocodeai/octocode-common/env";
import { promptRootsFromEnv, rebasePath } from "./worktree-paths/prompt-root.ts";
import { AGENT_ROLE_ENV } from "./team/store/env.ts";
import { BROWSER_SERVER } from "@octocodeai/octocode-common/mcp-names";
import { browserMcpTool } from "@octocodeai/octocode-common/browser-mcp";
import { type AgentProfile, profileSelectsBrowser } from "./subagents/profiles.ts";
import { currentRouting, ROUTING_NOTICE_ID, RoutingWatch } from "./subagents/routing-watch.ts";
import { agentCall } from "./child-sessions/agent-call.ts";
import { entryMessage } from "./shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Where this session's replies go, for the `environment` section. Read at every prompt: `/settings` can turn Mermaid
 * off mid-session, and the volatile section absorbs the change without touching the cached policy.
 */
function environmentSurface(api: ExtensionAPI, ctx: ExtensionContext, isSubagent: boolean): EnvironmentSurface {
	const surface: SessionSurface | undefined = isSubagent ? "subagent" : ctx.mode;
	// Only a terminal this process draws in has a host worth naming; an RPC client's terminal is not this one.
	const host = surface === "tui" || surface === "print" ? terminalHostFacts(process.env).join(", ") : "";
	// Only the terminal UI draws Mermaid (`modes/interactive/components/mermaid.ts`); `final` still draws it once done.
	const mermaid =
		surface === "tui" && typeof api.getSettings === "function" && api.getSettings().markdown?.mermaid !== "off";
	return {
		surface,
		host: host || undefined,
		mermaid,
	};
}

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
	// The `children` section (how to run children and use their reports) is sent from the session's first `agent` call
	// that starts a child or messages an agent, and stays from then on: `delegated` never turns false within a session.
	let delegated = false;
	let entriesRead = false;
	let policyInputs: (Parameters<typeof octocodePromptSections>[0] & { childStarted: boolean }) | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	const readOnly = options.isSubagent && envFlag(process.env, READ_ONLY_ENV);
	const lean = options.isSubagent && envFlag(process.env, LEAN_ENV);
	// Skills the parent chose ride in the task (`subagents/task-skills.ts`), so the cached prompt does not depend on them.
	const skillsInTask = lean || (options.isSubagent && envFlag(process.env, SKILLS_IN_TASK_ENV));
	const promptRoots = options.isSubagent ? promptRootsFromEnv(process.env) : undefined;
	// Only the coordinator routes tasks: its prompt states the routes once per session, later changes arrive as a notice.
	const routing = new RoutingWatch();
	const coordinates = (selected: readonly string[]) => !options.isSubagent && selected.includes("agent");

	api.on("before_agent_start", async (event, ctx) => {
		// Read each turn: the prompt changes only when a person attaches or leaves, not on its own.
		const hasUI = ctx.hasUI;
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
				? {
						prefix: roles.prefix,
						reader: roles.reader,
						search: roles.search,
						...(roles.judge ? { judge: roles.judge } : {}),
					}
				: undefined;
		const profiles = [...options.profiles().values()];
		const reading = coordinates(selected) ? currentRouting(ctx, profiles) : undefined;
		const routes = routing.prompt(reading?.facts, reading?.catalog);
		const notice = ownsPrompt(ctx) ? undefined : routing.notice(reading?.facts, reading);
		// A child whose profile declares `browser.control` and that holds the browser server drives its own isolated
		// browser. Both are fixed by the profile, so every child of one profile keeps the same policy text.
		const ownProfile = options.isSubagent ? options.profiles().get(process.env[AGENT_ROLE_ENV] ?? "") : undefined;
		const browserControl = browserMcp && ownProfile?.permissions?.includes("browser.control") === true;
		// A resumed, reloaded or forked session: its entries say whether it delegated before this process. Read once.
		if (!options.isSubagent && !delegated && !entriesRead) {
			entriesRead = true;
			delegated = hasDelegated(ctx.sessionManager?.getEntries() ?? []);
		}
		const inputs = {
			research,
			profiles: profiles.map(({ name, description }) => ({ name, description, model: routes?.profiles[name] })),
			routing: routes && {
				sessionModel: routes.sessionModel,
				providers: routes.providers,
				small: routes.small,
				medium: routes.medium,
			},
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
			canBacklog: selected.includes("backlog") && selected.includes("backlogPlan"),
			// What the selection allows, never what has connected: a server coming up must not change these bytes.
			canReadLocal:
				research !== undefined && (typeof api.selectsTools !== "function" || api.selectsTools(research.reader, true)),
			canAsk: selected.includes("askUser") && hasUI,
			// Availability follows the connected servers; a global MCP opt-out still applies.
			canMcp: canReachMcp(selected),
			browserControl,
			childStarted: delegated,
		};
		policyInputs = lean ? undefined : inputs;
		const key = JSON.stringify(inputs);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = lean
				? leanPromptSections({
						canShell: inputs.canShell,
						canSave: inputs.canSave,
						readOnly,
						agentTool: inputs.canUseAgent,
					})
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
			environmentSurface(api, ctx, options.isSubagent),
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
			// Keep skill routing metadata; task-specific bodies are read only when needed. A child cannot run /harness, so
			// its prompt leaves out the harnesses line.
			event.systemPromptOptions.sections.docs = "";
			event.systemPromptOptions.sections.harnesses = "";
			event.systemPromptOptions.skills = skillsInTask ? [] : childSkills(event.systemPromptOptions.skills ?? []);
		}
		return notice ? { message: { customType: ROUTING_NOTICE_ID, content: notice, display: false } } : undefined;
	});

	// The call is seen before it runs, so the rules are in the request that reads its result: a foreground child's report
	// arrives as that result. A refused call counts too; the section is then early, never missing.
	api.on("tool_call", (event) => {
		if (!options.isSubagent && event.toolName === "agent" && waitsOnAnAgent(event.input)) delegated = true;
	});

	// The next request of the same run: before_agent_start runs only when a run starts, and the first child starts inside one.
	api.on("turn_prompt", (event) => {
		if (!delegated || policyInputs === undefined || policyInputs.childStarted) return;
		policyInputs = { ...policyInputs, childStarted: true };
		promptKey = JSON.stringify(policyInputs);
		prompt = octocodePromptSections(policyInputs);
		if (prompt.children) event.systemPromptOptions.sections.children = prompt.children;
	});

	api.on("session_compact", () => routing.compacted());

	// A change made during a run (a command while the agent works) reaches it after the current turn, not at the next prompt.
	api.on("turn_end", (_event, ctx) => {
		if (!coordinates(api.getActiveTools()) || ownsPrompt(ctx)) return;
		const reading = currentRouting(ctx, options.profiles().values());
		const notice = routing.notice(reading.facts, reading);
		if (notice)
			void api.sendMessage({ customType: ROUTING_NOTICE_ID, content: notice, display: false }, { triggerTurn: false });
	});

	return {
		reset() {
			prompt = undefined;
			promptKey = undefined;
			policyInputs = undefined;
			delegated = false;
			entriesRead = false;
			routing.reset();
		},
	};
}

/**
 * Whether the session's model runs in its vendor's own CLI (Claude Code as the session's model): that CLI keeps its own
 * system prompt, so Octocode's `<delegation>` never reaches it and a routing notice would amend text it never saw. The
 * notice waits, unspent, for the next model that reads Octocode's prompt.
 */
const ownsPrompt = (ctx: Pick<ExtensionContext, "model" | "modelRegistry">): boolean =>
	ctx.model !== undefined && ctx.modelRegistry.getProviderKind(ctx.model.provider) === "CLI";

/** Whether an `agent` call starts something the session then waits on: a child, or a message to a peer or an outside agent. Only `coordinate` does not. */
const waitsOnAnAgent = (args: unknown): boolean => agentCall(args).type !== "coordinate";

/** Whether the session's entries hold such a call. */
function hasDelegated(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		const message = entryMessage(entry);
		return (
			isRecord(message) &&
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) => isRecord(part) && part.type === "toolCall" && part.name === "agent" && waitsOnAnAgent(part.arguments),
			)
		);
	});
}

/** Whether this session can reach MCP at all: the native `mcp` tool or declared server tools. */
const canReachMcp = (selected: readonly string[]): boolean =>
	selected.some((name) => name === "mcp" || name.startsWith("mcp__"));

/** Copy the skill metadata so child prompt preparation cannot mutate the loader's catalog. */
export function childSkills(skills: readonly Skill[]): Skill[] {
	return skills.map((skill) => ({ ...skill }));
}
