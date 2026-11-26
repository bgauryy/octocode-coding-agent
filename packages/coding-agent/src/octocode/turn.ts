import type { FeatureSetup, FeatureContext } from "../core/features/index.ts";
import { leanMainPolicy } from "../core/lean-main.ts";
import {
	currentEnvironment,
	type EnvironmentSurface,
	linkedWorktreeFact,
	type SessionSurface,
} from "../core/system-prompt.ts";
import { terminalHostFacts } from "@octocodeai/octocode-common/terminal-host";
import { FILE_TOOL } from "../core/tools/tool-names.ts";
import { leanPromptSections } from "./native/prompts/lean.ts";
import { octocodePromptSections, type ResearchContext } from "./native/prompts/policy.ts";
import { readRolePrompt } from "./native/prompts/role.ts";
import { getMcpSessionStatus, currentToolRoles, mcpServerMayRun } from "../../../mcp/src/api.ts";
import { envFlag, LEAN_ENV, READ_ONLY_ENV } from "@octocodeai/octocode-common/env";
import type { SkillCatalog } from "./skill/catalog.ts";
import { SUBAGENTS_SKILL } from "./skill/first-use.ts";
import { promptRootsFromEnv, rebasePath } from "./worktree-paths/prompt-root.ts";
import { AGENT_ROLE_ENV } from "./team/store/env.ts";
import { BROWSER_SERVER, DESKTOP_SERVER, mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { browserMcpTool } from "@octocodeai/octocode-common/browser-mcp";
import { type AgentProfile, profileSelectsBrowser, profileSelectsServer } from "./subagents/profiles.ts";
import { currentRouting, ROUTING_NOTICE_ID, RoutingWatch } from "./subagents/routing-watch.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { harnessSource, sourcedText } from "./events/source.ts";

/**
 * Where this session's replies go, for the `environment` section. Read at every prompt: `/settings` can turn Mermaid
 * off mid-session, and the volatile section absorbs the change without touching the cached policy.
 */
function environmentSurface(api: FeatureSetup, ctx: FeatureContext, isSubagent: boolean): EnvironmentSurface {
	const surface: SessionSurface | undefined = isSubagent ? "subagent" : ctx.mode;
	// Only a terminal this process draws in has a host worth naming; an RPC client's terminal is not this one.
	const host = surface === "tui" || surface === "print" ? terminalHostFacts(process.env).join(", ") : "";
	// Only the terminal UI draws Mermaid (`modes/interactive/components/mermaid.ts`); `final` still draws it once done.
	const mermaid =
		surface === "tui" && typeof api.settings.get === "function" && api.settings.get().markdown?.mermaid !== "off";
	return {
		surface,
		host: host || undefined,
		mermaid,
	};
}

/**
 * Whether the selected `agent` tool declares `runner`: an installed vendor CLI can take a task. Fixed for the session
 * (runners are discovered when it starts), so it keeps the policy bytes stable.
 */
function declaresRunner(api: FeatureSetup, selected: readonly string[]): boolean {
	if (!selected.includes("agent") || typeof api.tools.getAll !== "function") return false;
	const agent = api.tools.getAll().find((tool) => tool.name === "agent");
	const properties = isRecord(agent?.parameters) ? agent.parameters.properties : undefined;
	return isRecord(properties) && properties.runner !== undefined;
}

/** Adds the cached native prompt section without changing the session's selected tools. */
export function registerTurnSetup(
	api: FeatureSetup,
	options: {
		isSubagent: boolean;
		/** The `skill` tool's catalog: a lean main session withholds its listing. */
		skillCatalog?: SkillCatalog;
		profiles: () => Map<string, AgentProfile>;
	},
): { reset(): void } {
	let prompt: Record<string, string> | undefined;
	let promptKey: string | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	const readOnly = options.isSubagent && envFlag(process.env, READ_ONLY_ENV);
	const lean = options.isSubagent && envFlag(process.env, LEAN_ENV);
	const promptRoots = options.isSubagent ? promptRootsFromEnv(process.env) : undefined;
	// Only the coordinator routes tasks: its prompt states the routes once per session, later changes arrive as a notice.
	const routing = new RoutingWatch();
	const coordinates = (selected: readonly string[]) => !options.isSubagent && selected.includes("agent");
	const leansMain = (ctx: Pick<FeatureContext, "model">) =>
		!options.isSubagent && leanMainPolicy(ctx.model, typeof api.settings.get === "function" ? api.settings.get() : {});

	api.bus.on("before_agent_start", async (event, ctx) => {
		// Read each turn: the prompt changes only when a person attaches or leaves, not on its own.
		const hasUI = ctx.hasUI;
		const selected = event.systemPromptOptions.selectedTools ?? api.tools.getActive();
		const servers = getMcpSessionStatus(api.channels);
		const roles = currentToolRoles().research;
		const server = roles && servers.find((server) => server.name === roles.server);
		// The built-in browser server selected for this agent, declared or still connecting, means this agent can browse
		// itself, so the delegation text names no browser specialist. Only enablement and selection count, not connection
		// state or the declared tools, so that text is the same before and after the server connects. By default only the
		// browser subagent selects it.
		const browserServer = servers.find((server) => server.name === BROWSER_SERVER);
		const browserMcp =
			(browserServer !== undefined && mcpServerMayRun(browserServer) && browserServer.state !== "unselected") ||
			selected.some((name) => browserMcpTool(name) !== undefined);
		// Only enablement and selection count, never connection state, so a server that is still connecting, or that
		// failed or stopped later, keeps the same policy bytes and the cached prefix. The `mcp_status` section carries the
		// state. The native `mcp` tool is always selected where MCP is allowed, so the answer does not change when the
		// server's own tools appear.
		const research: ResearchContext | undefined =
			roles &&
			(selected.some((name) => name.startsWith(roles.prefix)) ||
				(server !== undefined && mcpServerMayRun(server) && server.state !== "unselected" && canReachMcp(selected)))
				? {
						prefix: roles.prefix,
						reader: roles.reader,
						search: roles.search,
						...(roles.judge ? { judge: roles.judge } : {}),
					}
				: undefined;
		const profiles = [...options.profiles().values()];
		// A main session on a small window or a small-tier model gets the lean policy too: no delegation, no skill list, and
		// no routes, which wait (unfrozen) for a model that reads the full policy.
		const leanMain = leansMain(ctx);
		const reading = coordinates(selected) && !leanMain ? currentRouting(ctx, profiles) : undefined;
		const routes = leanMain ? undefined : routing.prompt(reading?.facts, reading?.catalog);
		const notice = ownsPrompt(ctx) || leanMain ? undefined : routing.notice(reading?.facts, reading);
		// A child whose profile declares `browser.control` and that holds the browser server drives its own isolated
		// browser. Both are fixed by the profile, so every child of one profile keeps the same policy text.
		const ownProfile = options.isSubagent ? options.profiles().get(process.env[AGENT_ROLE_ENV] ?? "") : undefined;
		const browserControl = browserMcp && ownProfile?.permissions?.includes("browser.control") === true;
		const desktopControl = ownProfile?.permissions?.includes("desktop.control") === true;
		// The main session names no desktop tool of its own, so it delegates to the profiles that select the desktop server.
		const desktopMcp = selected.some((name) => name.startsWith(`${mcpNamespace(DESKTOP_SERVER)}__`));
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
			desktopProfiles:
				!options.isSubagent && selected.includes("agent") && !desktopMcp
					? profiles.filter((profile) => profileSelectsServer(profile, DESKTOP_SERVER)).map(({ name }) => name)
					: [],
			canDelegate: !options.isSubagent,
			// A top-level session in a linked worktree is a proxy of its orchestrator (`policy/linked.md`).
			linked:
				!options.isSubagent &&
				!promptRoots &&
				event.systemPromptOptions.cwd !== undefined &&
				linkedWorktreeFact(event.systemPromptOptions.cwd) !== undefined,
			canUseAgent: selected.includes("agent"),
			canStartRunner: declaresRunner(api, selected),
			// Loadable by the model, so the first child task delivers it (`skill/first-use.ts`).
			subagentsSkill:
				!options.isSubagent &&
				options.skillCatalog?.invocable().some(({ skill }) => skill.name === SUBAGENTS_SKILL) === true,
			readOnly,
			// A read-only role keeps `file` for its reports; its profile, not its tools, says it leaves source unchanged.
			canSave: selected.includes(FILE_TOOL),
			canShell: selected.includes("bash") || selected.includes("powershell"),
			canWeb: selected.includes("web"),
			canBacklog: selected.includes("backlog") && selected.includes("backlogPlan"),
			// What the selection allows, never what has connected: a server coming up must not change these bytes.
			canReadLocal:
				research !== undefined && (typeof api.tools.selects !== "function" || api.tools.selects(research.reader, true)),
			canAsk: selected.includes("askUser") && hasUI,
			// Availability follows the connected servers; a global MCP opt-out still applies.
			canMcp: canReachMcp(selected),
			browserControl,
			desktopControl,
		};
		const leanNow = lean || leanMain;
		const key = JSON.stringify([leanNow, inputs]);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = leanNow
				? leanPromptSections({
						canShell: inputs.canShell,
						canSave: inputs.canSave,
						readOnly,
						agentTool: inputs.canUseAgent,
						main: leanMain,
					})
				: octocodePromptSections(inputs);
		}
		options.skillCatalog?.withhold(leanMain);
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
			// A child cannot run /harness, so its prompt leaves out the harnesses line.
			event.systemPromptOptions.sections.docs = "";
			event.systemPromptOptions.sections.harnesses = "";
		}
		return notice ? { message: { customType: ROUTING_NOTICE_ID, content: notice, display: false } } : undefined;
	});

	api.bus.on("session_compact", () => routing.compacted());

	// A change made during a run (a command while the agent works) reaches it after the current turn, not at the next prompt.
	api.bus.on("turn_end", async (_event, ctx) => {
		if (!coordinates(api.tools.getActive()) || ownsPrompt(ctx) || leansMain(ctx)) return;
		const reading = currentRouting(ctx, options.profiles().values());
		const notice = routing.notice(reading.facts, reading);
		// It starts no turn, so it settles at once; a failure reaches the bus's error report.
		if (notice)
			await api.session.sendMessage(
				{ customType: ROUTING_NOTICE_ID, content: sourcedText(notice, harnessSource("routing")), display: false },
				{ triggerTurn: false },
			);
	});

	return {
		reset() {
			prompt = undefined;
			promptKey = undefined;
			routing.reset();
		},
	};
}

/**
 * Whether the session's model runs in its vendor's own CLI (Claude Code as the session's model): that CLI keeps its own
 * system prompt, so Octocode's `<delegation>` never reaches it and a routing notice would amend text it never saw. The
 * notice waits, unspent, for the next model that reads Octocode's prompt.
 */
const ownsPrompt = (ctx: Pick<FeatureContext, "model" | "modelRegistry">): boolean =>
	ctx.model !== undefined && ctx.modelRegistry.getProviderKind(ctx.model.provider) === "CLI";

/** Whether this session can reach MCP at all: the native `mcp` tool or declared server tools. */
const canReachMcp = (selected: readonly string[]): boolean =>
	selected.some((name) => name === "mcp" || name.startsWith("mcp__"));
