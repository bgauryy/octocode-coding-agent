import { registerArchiveLifecycle } from "./archive/lifecycle.ts";
import { registerRunGuards } from "./run-guards.ts";
import { registerNativeSessionLifecycle } from "./session-lifecycle.ts";
import { registerHarnessCommand } from "./harness/command.ts";
import { registerPlanning } from "./plan/register.ts";
import { withNativePermissionOwners } from "./permission/native-tools.ts";
import { registerDeferredSchemaRestore } from "./compaction/deferred-schemas.ts";
import { AGENT_GOAL_ENV, AGENT_ID_ENV, AGENT_ROLE_ENV } from "./team/store/env.ts";
import { FileGuard } from "./files/tool/guard.ts";
import { registerWebCommands } from "./remote/register.ts";
import { setShellPathEntries } from "../utils/shell.ts";
import { registerOctocodeCli } from "./cli/command.ts";
import { octocodeShimDir } from "./cli/shim.ts";
import { getApplicationPortForSession } from "../core/application/index.ts";
import { sessionNativeTools, startTrustedWorkspaceWeb } from "./workspace-web.ts";
import { teamView, WorkspaceRuntime } from "./workspace/runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/features/index.ts";
import { currentToolRoles } from "../../../mcp/src/api.ts";
import { agentModes, agentOperation } from "./agent-tool.ts";
import { runningApiInstances } from "./api/register.ts";
import { registerAskUser } from "./ask/tool.ts";
import { registerBacklog } from "./backlog/index.ts";
import { registerArchiveCommand } from "./archive/command.ts";
import { registerArchiveTool } from "./archive/tool.ts";
import { registerCompaction, registerCompactTool } from "./compaction/register.ts";
import { registerClaudeCode } from "./claude-code/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import { connectedRunners, runnerRows } from "./external/connected.ts";
import { externalListing } from "./external/describe.ts";
import { externalAgentSelection } from "./external/enabled.ts";
import { externalPermission } from "./external/permission-dialog.ts";
import { Peers } from "./external/peers.ts";
import { externalIdentity, registerExternal } from "./external/register.ts";
import { applyBashEnvironmentSetting } from "./files/bash-env.ts";
import { registerBashTool } from "./files/bash.ts";
import { Checkpoints } from "./files/checkpoint.ts";
import { registerCheckpoints } from "./files/checkpoint-command.ts";
import { registerReadReceipts } from "./files/read-receipts.ts";
import { registerNestedContext } from "./files/nested-context.ts";
import { contextReads } from "./files/reads.ts";
import { projectEditHunk, registerFileTool } from "./files/tool.ts";
import { registerHooksPromptSection } from "./hooks/prompt-section.ts";
import { registerHooks } from "./hooks/register.ts";
import type { HooksView } from "./hooks/register/types.ts";
import { registerMemory } from "./memory/register.ts";
import { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import { Permission } from "./permission/ask.ts";
import { registerPermissionCommand } from "./permission/command.ts";
import { createProvenance } from "./permission/provenance.ts";
import { recordChildReports, startPermissionState } from "./permission/provenance/reports.ts";
import { installPermissionPorts } from "./permission/ports.ts";
import { planReadOnly } from "./permission/shell/plan-reads.ts";
import { stopConfirmation } from "./permission/stop-confirm.ts";
import { registerProcesses } from "./processes/register.ts";
import { registerWorktrees } from "./worktrees/register.ts";
import { Subcommands } from "./shared/commands.ts";
import { envFlag, READ_ONLY_ENV, SUBAGENT_ENV } from "../../../common/src/env.ts";
import { setCurrentSession } from "./shared/home.ts";
import { registerTrustCommand } from "./trust/command.ts";
import { registerSecurityCommand } from "./guard/command.ts";
import "./guard/install.ts";
import { registerSkills } from "./skills.ts";
import { registerPromptOptimization } from "./prompt-optimization/register.ts";
import { registerTerminal } from "./terminal/register.ts";
import { registerSkillTool } from "./skill/tool.ts";
import { statusCommand } from "./status-command.ts";
import { refreshCatalog } from "./subagents/catalog.ts";
import { maxSubagents } from "./subagents/claim.ts";
import { registerModels } from "./subagents/models-command.ts";
import { registerModelsTool } from "./subagents/models-tool.ts";
import { registerChildRunnerTask } from "./subagents/runner-task.ts";
import type { AgentProfile } from "./subagents/profiles.ts";
import { registerChildSession } from "./subagents/child-session.ts";
import { loadSessionProfiles } from "./subagents/session-profiles.ts";
import { registerHarnessSync } from "./subagents/harness-sync.ts";
import { type AgentControl, budgetsThrough, mergeThrough, registerAgentTool } from "./subagents/tool.ts";
import { messagePolicy } from "./message-policy.ts";
import { Team } from "./team/session.ts";
import { changeNote } from "./team/edits.ts";
import { registerCollab } from "./team/tools.ts";
import { registerToolGates } from "./tool-gates.ts";
import { registerTurnSetup } from "./turn.ts";
import { registerStallRecorder } from "./profiler/stalls.ts";
import { registerActivity } from "./ui/activity.ts";
import { packageVersion, registerUi } from "./ui/chrome.ts";
import { Delivery } from "./ui/delivery.ts";
import { registerEditor } from "./ui/editor.ts";
import { registerNotify } from "./ui/notify.ts";
import { registerWebTool } from "./web/web.ts";
import { installOctocodeDiscovery } from "./discovery/index.ts";
import { registerLeaveConfirmation, registerReaderRole } from "./session-guards.ts";
import { registerExternalApi, registerTeamSessions, shellCollaboration } from "./team-surfaces.ts";
/**
 * Native features compose guarded tools, subagents, collaboration and session policy. The MCP host owns its servers.
 * Cross-cutting runtime policy is composed here, in an order that reads top to bottom: the `tool_call` gate pipeline
 * (invariants, hooks, then the permission mode; every refusal it makes and every call is audited), the hold that keeps a
 * headless run open for its background work, and the confirmation before a session switch or fork stops that work.
 * Domains supply the pieces (a gate, a `settle()`, a count): the loop guard's refusal is the pipeline's `loop` step. The
 * only other `tool_call` handler, `turn.ts`'s, observes `agent` calls and never decides. Octocode runs an event's
 * handlers in registration order, so a feature registers where its handlers belong, and a feature composed further down
 * is reached from earlier callbacks through `later` (none of them runs during composition). Two more events have domain
 * handlers whose order matters:
 * - `session_before_fork`: the leave confirmation here runs before the checkpoint file-restore offer
 *   (`files/checkpoint-command`), because it is registered before `registerCheckpoints`.
 * - `agent_before_settle`: the Stop hook continuation (`hooks/register`) and the too-large retry
 *   (`compaction/register`) are registered before the headless hold at the end of this function, so a continued or
 *   retried run is decided before the hold waits for background work.
 */
/** The features composed further down, by name: reading one before it is set throws an error that names it. */
function composedLater<T extends object>() {
	const values: Partial<T> = {};
	return {
		set: <K extends keyof T>(name: K, value: T[K]): T[K] => (values[name] = value),
		get: <K extends keyof T>(name: K): T[K] => {
			const value = values[name];
			if (value === undefined) throw new Error(`Octocode used ${String(name)} before composing it`);
			return value;
		},
	};
}

export default function octocode(host: ExtensionAPI): void {
	const api = withNativePermissionOwners(host);
	installOctocodeDiscovery(); // Agents, hooks, plugins and MCP servers join configuration discovery.
	const isSubagent = envFlag(process.env, SUBAGENT_ENV);
	setShellPathEntries(() => [octocodeShimDir()].filter((dir) => dir !== undefined)); // `octocode` in agent shells.
	installPermissionPorts({ mcpReadOnly: () => currentToolRoles().readOnly });
	// First, so every feature's api.sendMessage goes through it and its agent_settled handler runs before theirs.
	Delivery.install(api);
	const commands = new Subcommands();
	// Composed where their handlers belong in the order, after features whose callbacks already use them.
	const later = composedLater<{
		hooks: HooksView;
		sourcePolicy: ReturnType<typeof registerSourcePolicy>;
		messaging: ReturnType<typeof messagePolicy>;
	}>();
	const guard = new FileGuard();
	const team = new Team(api);
	let profiles = new Map<string, AgentProfile>();
	/** Why each profile file was refused at load (`loadSessionProfiles`), by profile name: the `agent` tool names it for an unknown profile. */
	let refused = new Map<string, string>();
	registerReaderRole(api, guard);
	// One permission state per session: the mode, its grants, and the provenance tripwire's index.
	const permission = new Permission({ api, isSubagent, agent: () => team.id });
	const provenance = createProvenance();
	// Vendor CLIs using their own sign-in run `agent` tasks over ACP (`external/connected.ts`).
	const externalAccess = externalAgentSelection();
	const runners = connectedRunners(externalAccess.enabled, externalPermission(permission), externalAccess.runners);
	// With Claude Code connected on its plan, its models run this session's turns with Octocode's tools over MCP.
	registerClaudeCode(api, runners.states);
	api.on("session_start", async (event, ctx) => {
		// Before anything writes output: spilled results, bash logs and checkpoints go to this session's folder.
		setCurrentSession(ctx.sessionManager.getSessionId(), ctx.cwd, ctx.sessionManager);
		startPermissionState(permission, provenance, ctx, event.reason);
		applyBashEnvironmentSetting();
	});
	const localReads = registerReadReceipts(api);
	// After the receipts: it reads the files they credit.
	registerNestedContext(api);
	// Every result, nested tool calls included, before any later call can repeat its text.
	api.on("tool_result", async (event, ctx) => provenance.record(agentOperation(event), ctx));
	recordChildReports(api, provenance, permission, isSubagent);
	guard.reservedBy = (file) => team.reservation(file, file);
	guard.modifiedBy = (file) => changeNote(team.editLog(), file, team.id);
	const checkpoints = new Checkpoints();
	registerFileTool(api, guard, permission, checkpoints, {
		enabled: (input, cwd) => later.get("hooks").hasFilePermissionRequest(input, cwd),
		committed: (id, input, cwd) => later.get("hooks").fileInputCommitted(id, input, cwd),
		refresh: (ctx) => later.get("sourcePolicy").refresh(ctx),
	});
	// Octocode's bash with a foreground deadline and background jobs.
	const jobs = registerBashTool(api, commands);
	// `octocode-<role>-<id>` process title, periodic memory samples, and `/processes`.
	const jobPids = () => [...jobs.jobs.values()].map((job) => job.pid);
	registerProcesses(api, { commands, isSubagent, jobPids, apiInstances: runningApiInstances });
	let agents: AgentControl | undefined;
	let external: ExternalAgents | undefined;
	const planning = registerPlanning(api, commands, async () => {
		await Promise.all([
			jobs.stopAll("user"),
			agents?.stopAll("plan mode"),
			external?.reset(),
			later.get("hooks").suspend?.(),
		]);
	});
	planning.readOnlyShell = planReadOnly;
	registerLeaveConfirmation(api, { isSubagent, jobs, agents: () => agents, external: () => external });
	registerCheckpoints(api, checkpoints, (file) => guard.forget(file), commands);
	registerTeamSessions(api, team, checkpoints, { commands, isSubagent });
	const workspace = isSubagent
		? undefined
		: new WorkspaceRuntime(api, {
				application: (ctx) => getApplicationPortForSession(ctx.sessionManager.getSessionId()),
				...teamView(team, true),
				tell: (to, text, signal) => team.send(to, text, { from: "user", signal }),
				stop: (to) => agents?.stop(to, "user") ?? (agents ? undefined : "Agent controls are unavailable."),
			});
	const backlogWeb = registerBacklog(api, {
		commands,
		isSubagent,
		agentId: () => team.id,
		openWeb: (ctx, backlog, changed) => startTrustedWorkspaceWeb(backlog, changed, workspace?.bind(ctx, backlog)),
	});
	if (!isSubagent)
		registerWebCommands(api, {
			commands,
			workspace,
			openWorkspace: backlogWeb.open,
			nativeTools: sessionNativeTools,
			boardChanged: backlogWeb.refresh,
		});
	registerMemory(api, { commands, isSubagent, permission, goal: process.env[AGENT_GOAL_ENV] });
	commands.add(
		"status",
		statusCommand(api, permission, () =>
			[
				`Octocode ${packageVersion() ?? ""}`.trim(),
				`Subagents: ${[...profiles.keys()].join(", ") || "none"} (at most ${maxSubagents()} at once)`,
				`Hooks: ${later.get("hooks").summary()}`,
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
				authorize: (target, text, ctx, signal) => later.get("messaging").authorizePeer(target, text, ctx, signal),
				notice: (content) =>
					void api.sendMessage(
						{ customType: "octocode-peer-notice", content, display: true },
						{ triggerTurn: true, deliverAs: "steer" },
					),
			});
	const collab = registerCollab(api, team, {
		stopAgent: isSubagent ? undefined : (id, by) => agents?.stop(id, by),
		mergeAgent: isSubagent ? undefined : mergeThrough(() => agents),
		...(peers
			? { peers, mergeBranch: (branch, ctx, signal) => later.get("messaging").mergeBranch(branch, ctx, signal) }
			: {}),
		...(isSubagent ? {} : { budgets: budgetsThrough(() => agents) }),
		beforeLeave: async (reason) => agents?.stopAll(reason),
		registerTool: agentTool.collect,
		...shellCollaboration(),
	});
	if (!isSubagent) {
		registerPermissionCommand(commands, permission, () => provenance.size(), planning);
		registerEditor(api, permission);
		registerTrustCommand(commands);
		registerSecurityCommand(commands);
		registerOctocodeCli(api, commands, permission.typed.bind(permission));
		registerWorktrees(
			api,
			commands,
			team,
			() => agents?.parked() ?? [],
			(branch, ctx) => later.get("messaging").typedMerge(branch, ctx),
		);
		registerAskUser(api, (id) => team.readMessage(id, team.id ?? ""));
		registerTerminal(api);
		agents = registerAgentTool(api, {
			profiles: () => profiles,
			team,
			permission,
			refused: () => refused,
			registerTool: agentTool.collect,
			runners,
		});
		commands.add("agents", agents.command);
		// A user's narrowing mode change names the running subagents it would stop and asks first.
		permission.setConfirmStop(stopConfirmation(() => agents?.running() ?? [], isSubagent));
		registerModels(commands, () => profiles);
		registerModelsTool(
			api,
			() => profiles,
			async (ctx, _signal, filters) => [
				...runnerRows(runners.states, filters),
				...(externalAccess.enabled ? await externalListing(external, ctx, filters) : []),
			],
		);
	} else if (runners.ids.length > 0) registerChildRunnerTask(runners, permission, agentTool.collect, team);
	registerSkills(api);
	registerPromptOptimization(commands, api);
	registerUi(api, isSubagent);
	registerStallRecorder(api);
	// What the agent does now: Octocode's working line (main session) and the team panel's activity column (every agent).
	const activity = registerActivity(api, { workingLine: !isSubagent, onChange: (line) => team.setActivity(line) });
	// Every call a permission check lets through (full mode asks nothing) shows as a short line while its tool runs.
	permission.onAction((event) => activity.consequential(event.action, event.what, event.warn));
	const turn = registerTurnSetup(api, {
		isSubagent,
		profiles: () => profiles,
		canExternal: () => agentTool.has("external"),
	});
	const hooks = later.set(
		"hooks",
		registerHooks(api, {
			env: process.env,
			onFailure: (what, note, allowed) => permission.noted(what, note, { allowed, via: "hook" }),
			metadata: () => ({
				permissionMode: permission.mode,
				agentName: process.env[AGENT_ID_ENV],
				agentType: process.env[AGENT_ROLE_ENV],
			}),
			paused: planning.blocked,
			projectEdit: (query, path, cwd) => projectEditHunk(query, path, guard, cwd),
		}),
	);
	registerHooksPromptSection(api, hooks);
	const applySourcePolicy = () => {
		const policy = later.get("sourcePolicy");
		permission.setSourcePolicy(policy.evaluate, policy.unprojected);
	};
	const sourcePolicy = later.set("sourcePolicy", registerSourcePolicy(api, { onChange: applySourcePolicy }));
	applySourcePolicy();
	permission.setResolver((ctx, invocation, signal) =>
		hooks.permissionRequest(invocation, ctx as ExtensionContext, signal),
	);
	permission.setUpdateHandler(async (ctx, updates, signal) => {
		await sourcePolicy.refresh(ctx as ExtensionContext);
		signal.throwIfAborted();
		return sourcePolicy.prepareUpdates(ctx as ExtensionContext, updates);
	});
	const messaging = later.set("messaging", messagePolicy({ api, hooks, permission, planning, provenance, team }));
	team.setMessageHook(messaging.beforeMessage);
	if (!isSubagent) {
		external = registerExternal(
			api,
			commands,
			{
				...externalIdentity(team),
				enabledRunners: externalAccess.runners,
				beforeSend: messaging.beforeMessage,
				afterReceive: (message, ctx) => hooks.messageReceive(message, ctx),
				authorize: messaging.authorizeExternal,
				permission: externalPermission(permission),
			},
			// Opt-in: without the `externalAgents` setting the `agent` tool does not declare `external` (`/agents external` stays).
			externalAccess.enabled ? agentTool.collect : () => undefined,
		);
		permission.onRevoke(() => void external?.reset());
	}
	agentTool.register(api);
	// After the hooks (handlers run in registration order): a PreCompact hook runs before Octocode adds its `file` tool's
	// paths to the file lists Octocode carries into its summary. Octocode writes the summary itself.
	registerCompactTool(api, registerCompaction(api, guard, isSubagent, team.parentId), isSubagent);
	registerDeferredSchemaRestore(api);
	if (isSubagent) registerChildSession(api);
	registerArchiveCommand(commands);
	registerArchiveTool(api, { isSubagent });
	const closeArchive = registerArchiveLifecycle(api, {
		canProject: () => !planning.blocked() && !envFlag(process.env, READ_ONLY_ENV),
		agentId: () => team.id,
		parentId: () => team.parentId,
	});
	registerSkillTool(api);
	const runGuards = registerRunGuards(api); // after the file guard: see run-guards.ts
	registerHarnessCommand(commands, hooks, api);
	// Subagents have no terminal of their own: their parent's row and report carry their state. A child follows the parent's `/harness` switches instead.
	if (isSubagent) registerHarnessSync(api);
	else registerNotify(api, { onNotice: hooks.notification });
	const externalApi = isSubagent
		? undefined
		: registerExternalApi(api, commands, { team, messaging, permission, planning, external: () => external });
	api.on("session_start", async (_event, ctx) => {
		// Per-session state first: a later step that throws (API port in use) must not carry the old session's over.
		turn.reset();
		await external?.reset();
		peers?.reset();
		// Reads in a resumed, reloaded or forked session's context still count; a new session starts empty.
		guard.restore(contextReads(ctx));
		({ profiles, refused } = loadSessionProfiles(api, ctx, isSubagent));
		await externalApi?.start(ctx);
		// The models.dev index, refreshed in the background, so the first subagent of the day routes with it. A fresh saved
		// index is not parsed here: its first reader does that, after the first paint.
		if (!isSubagent) refreshCatalog();
	});

	// The tool-call pipeline, its cleanup and the user's own `!cmd` (`tool-gates.ts`).
	registerToolGates(api, {
		loop: runGuards.loop,
		permission,
		provenance,
		collab,
		hooks,
		sourcePolicy,
		activity,
		localReads,
		planning,
		peerSessions: () =>
			team.members().some((member) => member.role === "main" && member.id !== team.id && !member.worktree),
	});
	registerNativeSessionLifecycle(api, { isSubagent, team, permission, jobs, agents, external, api: externalApi });
	api.on("session_shutdown", async () => closeArchive());
	// Register each native command once, after every feature has supplied its handler.
	commands.register(api);
}
