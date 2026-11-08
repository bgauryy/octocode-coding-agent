import { registerArchiveLifecycle } from "./archive/lifecycle.ts";
import { registerRunGuards } from "./run-guards.ts";
import { registerNativeSessionLifecycle } from "./session-lifecycle.ts";
import { registerHarnessCommand } from "./harness/command.ts";
import { registerPlanning } from "./plan/register.ts";
import { withNativePermissionOwners } from "./permission/native-tools.ts";
import { AGENT_GOAL_ENV, AGENT_ID_ENV, AGENT_ROLE_ENV } from "./team/store/env.ts";
import { BASH_READER, FileGuard, mcpReader } from "./files/tool/guard.ts";
import { plural } from "./shared/render/text.ts";
import { spilledMessage } from "./team/session/spilled-message.ts";
import { registerWebCommands } from "./remote/register.ts";
import { setShellPathEntries } from "../utils/shell.ts";
import { registerOctocodeCli } from "./cli/command.ts";
import { octocodeShimDir } from "./cli/shim.ts";
import { getApplicationPortForSession } from "../core/application/index.ts";
import { startTrustedWorkspaceWeb } from "./workspace-web.ts";
import { teamView, WorkspaceRuntime } from "./workspace/runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/features/index.ts";
import { getMcpSessionStatus, MCP_STATUS_EVENT } from "../../../mcp/src/status.ts";
import { currentToolRoles } from "../../../mcp/src/roles.ts";
import { agentModes, agentOperation } from "./agent-tool.ts";
import { registerApi, runningApiInstances } from "./api/register.ts";
import { registerAskUser } from "./ask/tool.ts";
import { registerBacklog } from "./backlog/index.ts";
import { registerArchiveCommand } from "./compaction/archive-command.ts";
import { registerArchiveTool } from "./archive/tool.ts";
import { registerCompaction, registerCompactTool } from "./compaction/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import { externalAgentsEnabled } from "./external/enabled.ts";
import { externalPermission } from "./external/permission-dialog.ts";
import { Peers } from "./external/peers.ts";
import { externalIdentity, registerExternal } from "./external/register.ts";
import { applyBashEnvironmentSetting } from "./files/bash-env.ts";
import { registerBashTool } from "./files/bash.ts";
import { Checkpoints } from "./files/checkpoint.ts";
import { registerCheckpoints } from "./files/checkpoint-command.ts";
import { registerReadReceipts } from "./files/read-receipts.ts";
import { contextReads } from "./files/reads.ts";
import { projectEditHunk, registerFileTool } from "./files/tool.ts";
import { registerHooksPromptSection } from "./hooks/prompt-section.ts";
import { registerHooks } from "./hooks/register.ts";
import { registerMemory } from "./memory/register.ts";
import { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import { Permission } from "./permission/ask.ts";
import { registerPermissionCommand } from "./permission/command.ts";
import { createProvenance } from "./permission/provenance.ts";
import { recordChildReports, startPermissionState } from "./permission/provenance/reports.ts";
import { parsedShell, reservationTargets, shellMutation, shellParserReady } from "./permission/shell/mutation.ts";
import { installPermissionPorts } from "./permission/ports.ts";
import { readOnlyCommand } from "./permission/shell/read-only.ts";
import { planReadOnly } from "./permission/shell/plan-reads.ts";
import { stopConfirmation } from "./permission/stop-confirm.ts";
import { registerProcesses } from "./processes/register.ts";
import { registerSessions } from "./sessions/register.ts";
import { registerWorktrees } from "./worktrees/register.ts";
import { Subcommands } from "./shared/commands.ts";
import { envFlag, READ_ONLY_ENV, SUBAGENT_ENV } from "../../../common/src/env.ts";
import { setCurrentSession } from "./shared/home.ts";
import { interactive } from "./shared/interactive.ts";
import { withDialog } from "./shared/locks.ts";
import { EXTERNAL_SENDER } from "./shared/messages.ts";
import { registerTrustCommand } from "./trust/command.ts";
import { registerSkills } from "./skills.ts";
import { registerPromptOptimization } from "./prompt-optimization/register.ts";
import { registerSkillTool } from "./skill/tool.ts";
import { statusCommand } from "./status-command.ts";
import { currentCatalog } from "./subagents/catalog.ts";
import { maxSubagents } from "./subagents/claim.ts";
import { registerModels } from "./subagents/models-command.ts";
import { registerModelsTool } from "./subagents/models-tool.ts";
import type { AgentProfile } from "./subagents/profiles.ts";
import { registerIdentityReminder } from "./subagents/identity-reminder.ts";
import { loadSessionProfiles } from "./subagents/session-profiles.ts";
import { registerHarnessSync } from "./subagents/harness-sync.ts";
import { type AgentControl, budgetsThrough, mergeThrough, registerAgentTool } from "./subagents/tool.ts";
import { messagePolicy } from "./message-policy.ts";
import { Team } from "./team/session.ts";
import { changeNote } from "./team/edits.ts";
import { registerCollab } from "./team/tools.ts";
import { registerToolGates } from "./tool-gates.ts";
import { registerTurnSetup } from "./turn.ts";
import { registerActivity } from "./ui/activity.ts";
import { packageVersion, registerUi } from "./ui/chrome.ts";
import { Delivery } from "./ui/delivery.ts";
import { registerEditor } from "./ui/editor.ts";
import { registerNotify } from "./ui/notify.ts";
import { registerWebTool } from "./web/web.ts";
import { installOctocodeDiscovery } from "./discovery/index.ts";
/**
 * Native features compose guarded tools, subagents, collaboration and session policy. The MCP host owns its servers.
 * Cross-cutting runtime policy is composed here, in an order that reads top to bottom: the `tool_call` gate pipeline
 * (invariants, hooks, then the permission mode; every refusal and call is audited; no domain registers its own
 * `tool_call` handler), the hold that keeps a headless run open for its background work, and the confirmation before a
 * session switch or fork stops that work. Domains supply the pieces (a gate, a `settle()`, a count). Octocode runs an event's
 * handlers in registration order, and two events also have domain handlers whose order matters:
 * - `session_before_fork`: the leave confirmation here runs before the checkpoint file-restore offer
 *   (`files/checkpoint-command`), because it is registered before `registerCheckpoints`.
 * - `agent_before_settle`: the Stop hook continuation (`hooks/register`) and the too-large retry
 *   (`compaction/register`) are registered before the headless hold at the end of this function, so a continued or
 *   retried run is decided before the hold waits for background work.
 */
export default function octocode(host: ExtensionAPI): void {
	const api = withNativePermissionOwners(host);
	installOctocodeDiscovery(); // Agents, hooks, plugins and MCP servers join configuration discovery.
	const isSubagent = envFlag(process.env, SUBAGENT_ENV);
	setShellPathEntries(() => [octocodeShimDir()].filter((dir) => dir !== undefined)); // `octocode` in agent shells.
	installPermissionPorts({ mcpReadOnly: () => currentToolRoles().readOnly });
	// First, so every feature's api.sendMessage goes through it and its agent_settled handler runs before theirs.
	Delivery.install(api);
	const commands = new Subcommands();
	const guard = new FileGuard();
	const team = new Team(api);
	let profiles = new Map<string, AgentProfile>();
	/** Why each profile file was refused at load (`loadSessionProfiles`), by profile name: the `agent` tool names it for an unknown profile. */
	let refused = new Map<string, string>();
	// Refusals name the research entry's reader role (`roles`) while its server runs, and `bash` otherwise.
	const updateReader = () => {
		const research = currentToolRoles().research;
		const server = research && getMcpSessionStatus(api.events).find((server) => server.name === research.server);
		guard.reader =
			research && server?.enabled && !["failed", "stopped", "disabled"].includes(server.state)
				? mcpReader(research.reader)
				: BASH_READER;
	};
	api.events.on(MCP_STATUS_EVENT, updateReader);
	api.on("session_start", updateReader);
	// One permission state per session: the mode, its grants, and the provenance tripwire's index.
	const permission = new Permission({ api, isSubagent, agent: () => team.id });
	const provenance = createProvenance();

	api.on("session_start", async (event, ctx) => {
		// Before anything writes output: spilled results, bash logs and checkpoints go to this session's folder.
		setCurrentSession(ctx.sessionManager.getSessionId(), ctx.cwd, ctx.sessionManager);
		startPermissionState(permission, provenance, ctx, event.reason);
		applyBashEnvironmentSetting();
	});
	const localReads = registerReadReceipts(api);
	// Every result, nested tool calls included, before any later call can repeat its text.
	api.on("tool_result", async (event, ctx) => provenance.record(agentOperation(event), ctx));
	recordChildReports(api, provenance, permission, isSubagent);
	guard.reservedBy = (file) => team.reservation(file, file);
	guard.modifiedBy = (file) => changeNote(team.editLog(), file, team.id);
	const checkpoints = new Checkpoints();
	registerFileTool(api, guard, permission, checkpoints, {
		enabled: (input, cwd) => hooks.hasFilePermissionRequest(input, cwd),
		committed: (id, input, cwd) => hooks.fileInputCommitted(id, input, cwd),
		refresh: (ctx) => sourcePolicy.refresh(ctx),
	});
	// Octocode's bash with a foreground deadline and background jobs.
	const jobs = registerBashTool(api, commands);
	// `octocode-<role>-<id>` process title, periodic memory samples, and `/processes`.
	const jobPids = () => [...jobs.jobs.values()].map((job) => job.pid);
	registerProcesses(api, { commands, isSubagent, jobPids, apiInstances: runningApiInstances });
	let agents: AgentControl | undefined;
	let external: ExternalAgents | undefined;
	const planning = registerPlanning(api, commands, async () => {
		await Promise.all([jobs.stopAll("user"), agents?.stopAll("plan mode"), external?.reset(), hooks.suspend?.()]);
	});
	planning.readOnlyShell = planReadOnly;
	// /new, /resume, /fork and /quit end this runtime, its bash jobs and subagents: ask first, before the checkpoint handlers.
	const confirmLeave = async (ctx: ExtensionContext, action: string) => {
		if (!interactive(ctx, isSubagent)) return undefined;
		const running = [
			ctx.mode === "tui" && !ctx.isIdle() && "the running reply",
			jobs.jobs.size && plural(jobs.jobs.size, "bash job"),
			agents?.background() && plural(agents.background(), "background subagent"),
			external?.running && plural(external.running, "external prompt"),
		].filter(Boolean);
		if (running.length === 0) return undefined;
		const leave = await withDialog(() =>
			ctx.ui.confirm("Running work", `Stop ${running.join(" and ")} and ${action}?`),
		);
		return leave ? undefined : { cancel: true };
	};
	api.on("session_before_switch", async (event, ctx) =>
		confirmLeave(ctx, event.reason === "new" ? "start a new session" : "switch sessions"),
	);
	api.on("session_before_fork", async (_event, ctx) => confirmLeave(ctx, "fork"));
	api.on("session_before_quit", async (_event, ctx) => confirmLeave(ctx, "quit"));
	registerCheckpoints(api, checkpoints, (file) => guard.forget(file), commands);
	registerSessions(api, {
		commands,
		isSubagent,
		...(isSubagent && process.env[AGENT_GOAL_ENV] ? { goal: process.env[AGENT_GOAL_ENV] } : {}),
		filesChanged: () => new Set(checkpoints.list().map((entry) => entry.path)).size,
		team: {
			reservations: () => team.members().find((member) => member.id === team.id)?.locks ?? [],
			questions: () =>
				team
					.openQuestions()
					.filter((question) => question.recipient === team.id)
					.map(({ id, from, text }) => ({ id, from, text })),
		},
	});
	const workspace = isSubagent
		? undefined
		: new WorkspaceRuntime(api, {
				application: (ctx) => getApplicationPortForSession(ctx.sessionManager.getSessionId()),
				...teamView(team, true),
				tell: (to, text, signal) => team.send(to, text, { from: "user", signal }),
				stop: (to) => agents?.stop(to, "user") ?? (agents ? undefined : "Agent controls are unavailable."),
			});
	const openWorkspace = registerBacklog(api, {
		commands,
		isSubagent,
		agentId: () => team.id,
		openWeb: (ctx, backlog, changed) => startTrustedWorkspaceWeb(backlog, changed, workspace?.bind(ctx, backlog)),
	});
	if (!isSubagent) registerWebCommands(api, { commands, workspace, openWorkspace });
	const memoryTool = registerMemory(api, { commands, isSubagent, permission, goal: process.env[AGENT_GOAL_ENV] });
	commands.add(
		"status",
		statusCommand(api, permission, () =>
			[
				`Octocode ${packageVersion() ?? ""}`.trim(),
				`Subagents: ${[...profiles.keys()].join(", ") || "none"} (at most ${maxSubagents()} at once)`,
				`Hooks: ${hooks.summary()}`,
				// The registered commands, so a child session lists only its own; `/mcp` and `/llama` belong to their own extensions.
				`Commands: ${[...commands.list().map(([name]) => name), "mcp", "llama"].map((name) => `/${name}`).join(", ")}`,
			].join("\n"),
		),
	);
	registerWebTool(api, permission);
	const agentTool = agentModes();
	// Only a top-level session reaches other processes: a restricted child must not ask an unrestricted session to act.
	const peers = isSubagent
		? undefined
		: new Peers({
				authorize: (target, text, ctx, signal) => messaging.authorizePeer(target, text, ctx, signal),
				notice: (content) =>
					void api.sendMessage(
						{ customType: "octocode-peer-notice", content, display: true },
						{ triggerTurn: true, deliverAs: "steer" },
					),
			});
	const collab = registerCollab(api, team, {
		stopAgent: isSubagent ? undefined : (id, by) => agents?.stop(id, by),
		mergeAgent: isSubagent ? undefined : mergeThrough(() => agents),
		...(peers ? { peers, mergeBranch: (branch, ctx, signal) => messaging.mergeBranch(branch, ctx, signal) } : {}),
		...(isSubagent ? {} : { budgets: budgetsThrough(() => agents) }),
		beforeLeave: async (reason) => agents?.stopAll(reason),
		registerTool: agentTool.collect,
		shellWrites: (command) => shellParserReady().then(() => reservationTargets(command)),
		shellReadOnly: readOnlyCommand,
		shellCommands: parsedShell,
		shellChanges: async (command) => {
			await shellParserReady();
			return shellMutation(command).writes;
		},
	});
	if (!isSubagent) {
		registerPermissionCommand(commands, permission, () => provenance.size(), planning);
		registerEditor(api, permission);
		registerTrustCommand(commands);
		registerOctocodeCli(api, commands, permission.typed.bind(permission));
		registerWorktrees(
			api,
			commands,
			team,
			() => agents?.parked() ?? [],
			(branch, ctx) => messaging.typedMerge(branch, ctx),
		);
		registerAskUser(api, (id) => team.readMessage(id, team.id ?? ""));
		agents = registerAgentTool(
			api,
			() => profiles,
			team,
			permission,
			() => refused,
			agentTool.collect,
		);
		commands.add("agents", agents.command);
		// A user's narrowing mode change names the running subagents it would stop and asks first.
		permission.setConfirmStop(stopConfirmation(() => agents?.running() ?? [], isSubagent));
		registerModels(commands, () => profiles);
		registerModelsTool(api, () => profiles);
	}
	registerSkills(api);
	registerPromptOptimization(commands, api);
	registerUi(api, isSubagent);
	// What the agent does now: Octocode's working line (main session) and the team panel's activity column (every agent).
	const activity = registerActivity(api, { workingLine: !isSubagent, onChange: (line) => team.setActivity(line) });
	// Every call a permission check lets through (full mode asks nothing) shows as a short line while its tool runs.
	permission.onAction((event) => activity.consequential(event.action, event.what, event.warn));
	const turn = registerTurnSetup(api, {
		isSubagent,
		profiles: () => profiles,
		canExternal: () => agentTool.has("external"),
	});
	const hooks = registerHooks(
		api,
		process.env,
		undefined,
		(what, note, allowed) => permission.noted(what, note, { allowed, via: "hook" }),
		() => ({
			permissionMode: permission.mode,
			agentName: process.env[AGENT_ID_ENV],
			agentType: process.env[AGENT_ROLE_ENV],
		}),
		planning.blocked,
		(query, path, cwd) => projectEditHunk(query, path, guard, cwd),
	);
	registerHooksPromptSection(api, hooks);
	const applySourcePolicy = () => permission.setSourcePolicy(sourcePolicy.evaluate, sourcePolicy.unprojected);
	const sourcePolicy = registerSourcePolicy(api, undefined, applySourcePolicy);
	applySourcePolicy();
	permission.setResolver((ctx, invocation, signal) =>
		hooks.permissionRequest(invocation, ctx as ExtensionContext, signal),
	);
	permission.setUpdateHandler(async (ctx, updates, signal) => {
		await sourcePolicy.refresh(ctx as ExtensionContext);
		signal.throwIfAborted();
		return sourcePolicy.prepareUpdates(ctx as ExtensionContext, updates);
	});
	const messaging = messagePolicy({ api, hooks, permission, planning, provenance, team });
	team.setMessageHook(messaging.beforeMessage);
	if (!isSubagent) {
		external = registerExternal(
			api,
			commands,
			{
				...externalIdentity(team),
				beforeSend: messaging.beforeMessage,
				afterReceive: (message, ctx) => hooks.messageReceive(message, ctx),
				authorize: messaging.authorizeExternal,
				permission: externalPermission(permission),
			},
			// Opt-in: without the `externalAgents` setting the `agent` tool does not declare `external` (`/agents external` stays).
			externalAgentsEnabled() ? agentTool.collect : () => undefined,
		);
		permission.onRevoke(() => void external?.reset());
	}
	agentTool.register(api);
	// After the hooks (handlers run in registration order): a PreCompact hook runs before Octocode adds its `file` tool's
	// paths to the file lists Octocode carries into its summary. Octocode writes the summary itself.
	registerCompactTool(api, registerCompaction(api, guard, isSubagent, team.parentId), isSubagent);
	if (isSubagent) registerIdentityReminder(api);
	registerArchiveCommand(commands);
	registerArchiveTool(api, memoryTool);
	const closeArchive = registerArchiveLifecycle(api, {
		canProject: () => !planning.blocked() && !envFlag(process.env, READ_ONLY_ENV),
		agentId: () => team.id,
		parentId: () => team.parentId,
	});
	registerSkillTool(api);
	registerRunGuards(api); // after the file guard: see run-guards.ts
	registerHarnessCommand(commands, hooks, api);
	// Subagents have no terminal of their own: their parent's row and report carry their state. A child follows the parent's `/harness` switches instead.
	if (isSubagent) registerHarnessSync(api);
	else registerNotify(api, { onNotice: hooks.notification });
	const externalApi = isSubagent
		? undefined
		: registerApi(
				api,
				commands,
				{
					list: () => team.members(),
					tell: (to, text) => team.send(to, text, { from: EXTERNAL_SENDER }),
					deliverable: spilledMessage,
				},
				packageVersion,
				{
					messageSend: messaging.inboundHooks,
					admit: messaging.admit,
					capTurn: (ceiling) => permission.turnCap.set(ceiling),
					externalCall: (input, ctx) => {
						if (planning.blocked()) throw new Error("External agent calls are unavailable during planning.");
						return external!.call(input, ctx);
					},
				},
			);
	api.on("session_start", async (_event, ctx) => {
		// Per-session state first: a later step that throws (API port in use) must not carry the old session's over.
		turn.reset();
		await external?.reset();
		peers?.reset();
		// Reads in a resumed, reloaded or forked session's context still count; a new session starts empty.
		guard.restore(contextReads(ctx));
		({ profiles, refused } = loadSessionProfiles(api, ctx, isSubagent));
		await externalApi?.start(ctx);
		// The models.dev index, refreshed in the background, so the first subagent of the day routes with it.
		if (!isSubagent) currentCatalog();
	});

	// The tool-call pipeline, its cleanup and the user's own `!cmd` (`tool-gates.ts`).
	registerToolGates(api, {
		permission,
		provenance,
		collab,
		hooks,
		sourcePolicy,
		activity,
		localReads,
		planning,
	});
	registerNativeSessionLifecycle(api, { isSubagent, team, permission, jobs, agents, external, api: externalApi });
	api.on("session_shutdown", async () => closeArchive());
	// Register each native command once, after every feature has supplied its handler.
	commands.register(api);
}
