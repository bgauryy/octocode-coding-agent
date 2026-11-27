import { registerArchiveLifecycle } from "./archive/lifecycle.ts";
import { callSmallModel, smallModelLabel } from "./subagents/small-call.ts";
import { registerRunGuards } from "./run-guards.ts";
import { registerNativeSessionLifecycle } from "./session-lifecycle.ts";
import { registerHarnessCommand } from "./harness/command.ts";
import { registerPlanning } from "./plan/register.ts";
import { withNativePermissionOwners } from "./permission/native-tools.ts";
import { registerDeferredSchemaRestore } from "./compaction/deferred-schemas.ts";
import { AGENT_GOAL_ENV } from "./team/store/env.ts";
import { FileGuard } from "./files/tool/guard.ts";
import type { FileReplacementOwner } from "./files/tool/queries.ts";
import { attachmentContent, attachmentTexts } from "./team/attachment-source.ts";
import { setShellPathEntries } from "../utils/shell.ts";
import { registerOctocodeCli } from "./cli/command.ts";
import { octocodeShimDir } from "./cli/shim.ts";
import type { FeatureSetup } from "../core/features/index.ts";
import { currentToolRoles } from "../../../mcp/src/api.ts";
import { agentModes, agentOperation } from "./native/tools/agent/tool.ts";
import { runningApiInstances } from "./api/register.ts";
import { registerAskUser } from "./native/tools/ask-user/tool.ts";
import { registerRender } from "./native/tools/render/tool.ts";
import { registerConfigurationTool } from "./native/tools/configuration/tool.ts";
import { composeBacklog } from "./compose-backlog.ts";
import { composedLater } from "./compose-later.ts";
import { composePolicy, type ComposedLater } from "./compose-policy.ts";
import { registerArchiveCommand } from "./archive/command.ts";
import { registerMessagesCommand } from "./team/messages/command.ts";
import { liveMessagesData } from "./profiler/messages-source.ts";
import { registerArchiveTool } from "./native/tools/archive/tool.ts";
import { registerCompaction, registerCompactTool } from "./compaction/register.ts";
import { awaitsAnswer } from "./awaits-answer.ts";
import { registerClaudeCode } from "./claude-code/register.ts";
import { registerCliModels } from "./cli-models/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import { connectedRunners, runnerRows } from "./external/connected.ts";
import { externalListing } from "./external/describe.ts";
import { externalAgentSelection } from "./external/enabled.ts";
import { externalPermission } from "./external/permission-dialog.ts";
import { Peers } from "./external/peers.ts";
import { agentNameOf } from "./shared/agent-name.ts";
import { externalIdentity, registerExternal } from "./external/register.ts";
import { applyBashEnvironmentSetting } from "./files/bash-env.ts";
import { applySessionSandbox } from "./permission/sandbox/apply.ts";
import { registerBashTool } from "./native/tools/bash/tool.ts";
import { jobLinks } from "./backlog/job-links.ts";
import { Checkpoints } from "./files/checkpoint.ts";
import { registerCheckpoints } from "./files/checkpoint-command.ts";
import { registerReadReceipts } from "./files/read-receipts.ts";
import { registerNestedContext } from "./files/nested-context.ts";
import { contextReads } from "./files/reads.ts";
import { registerFileTool } from "./native/tools/file/tool.ts";
import { registerMemory } from "./memory/register.ts";
import { Permission } from "./permission/ask.ts";
import { registerPermissionCommand } from "./permission/command.ts";
import { createProvenance } from "./permission/provenance.ts";
import { recordChildReports, startPermissionState } from "./permission/provenance/reports.ts";
import { installPermissionPorts } from "./permission/ports.ts";
import { planReadOnly } from "./permission/shell/plan-reads.ts";
import { stopConfirmation } from "./permission/stop-confirm.ts";
import { registerProcesses } from "./processes/register.ts";
import { registerMonitor } from "./monitor/register.ts";
import { registerMonitorRoom } from "./monitor-room/command.ts";
import { registerUsage } from "./usage/command.ts";
import { registerWorktrees } from "./worktrees/register.ts";
import { checkoutSharers } from "./worktrees/sharing.ts";
import { Subcommands } from "./shared/commands.ts";
import { envFlag, LEAN_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { setCurrentSession } from "./shared/home.ts";
import { registerTrustCommand } from "./trust/command.ts";
import { registerSecurityCommand } from "./guard/command.ts";
import "./guard/install.ts";
import { registerSkills } from "./skills.ts";
import { registerPromptOptimization } from "./prompt-optimization/register.ts";
import { registerTerminal } from "./terminal/register.ts";
import { registerSkillTool } from "./native/tools/skill/tool.ts";
import { registerSkillFirstUse } from "./skill/first-use.ts";
import { SkillCatalog } from "./skill/catalog.ts";
import { statusCommand } from "./status-command.ts";
import { refreshCatalog } from "../core/model-catalog/index-store.ts";
import { maxSubagents } from "./subagents/claim.ts";
import { registerModels } from "./subagents/models-command.ts";
import { registerModelsTool } from "./native/tools/models/tool.ts";
import { registerChildRunnerTask } from "./subagents/runner-task.ts";
import type { AgentProfile } from "./subagents/profiles.ts";
import { registerChildSession } from "./subagents/child-session.ts";
import { loadSessionProfiles } from "./subagents/session-profiles.ts";
import { registerHarnessSync } from "./subagents/harness-sync.ts";
import { type AgentControl, registerAgentTool } from "./subagents/tool.ts";
import { budgetsThrough, mergeThrough } from "./subagents/control-through.ts";
import { Team } from "./team/session.ts";
import { connectGuard } from "./compose-guard.ts";
import { registerCollab } from "./native/tools/coordinate/tool.ts";
import { registerToolGates } from "./tool-gates.ts";
import { registerTurnSetup } from "./turn.ts";
import { registerStallRecorder } from "./profiler/stalls.ts";
import { registerActivity } from "./ui/activity.ts";
import { packageVersion, registerUi } from "./ui/chrome.ts";
import { Delivery } from "./ui/delivery.ts";
import { registerEditor } from "./ui/editor.ts";
import { registerNotify } from "./ui/notify.ts";
import { registerWebTool } from "./native/tools/web/tool.ts";
import { installOctocodeDiscovery } from "./discovery/index.ts";
import { registerLeaveConfirmation, registerReaderRole } from "./session-guards.ts";
import { collaborationPorts, registerExternalApi, registerTeamSessions } from "./team-surfaces.ts";
import { registerWake } from "./wake/register.ts";
import { registerAsyncJobs } from "./jobs/register.ts";
import { sendPeerNotice } from "./wake/senders.ts";
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
export default function octocode(host: FeatureSetup): void {
	const api = withNativePermissionOwners(host);
	installOctocodeDiscovery(); // Agents, hooks, plugins and MCP servers join configuration discovery.
	const isSubagent = envFlag(process.env, SUBAGENT_ENV);
	setShellPathEntries(() => [octocodeShimDir()].filter((dir) => dir !== undefined)); // `octocode` and `octocode-cli` in agent shells.
	installPermissionPorts({ mcpReadOnly: () => currentToolRoles().readOnly });
	// First, so every feature's api.session.sendMessage goes through it and its agent_settled handler runs before theirs.
	Delivery.install(api);
	const commands = new Subcommands();
	// Composed where their handlers belong in the order, after features whose callbacks already use them.
	const later = composedLater<ComposedLater>();
	const guard = new FileGuard();
	const team = new Team(api);
	let profiles = new Map<string, AgentProfile>();
	/** Why each profile file was refused at load (`loadSessionProfiles`), by profile name: the `agent` tool names it for an unknown profile. */
	let refused = new Map<string, string>();
	registerReaderRole(api, guard);
	// One permission state per session: the mode, its grants, and the provenance tripwire's index.
	const permission = new Permission({ api, isSubagent, agent: () => team.id });
	const provenance = createProvenance();
	// Vendor CLIs on their own sign-in run `agent` tasks over ACP and, as models (`cli-models/`), this session's turns.
	const externalAccess = externalAgentSelection();
	const runners = connectedRunners(externalAccess.enabled, externalPermission(permission), externalAccess.runners);
	registerClaudeCode(api, runners.states);
	registerCliModels(api, runners.states);
	api.bus.on("session_start", async (event, ctx) => {
		// Before anything writes output: spilled results, bash logs and checkpoints go to this session's folder.
		setCurrentSession(ctx.sessionManager.getSessionId(), ctx.cwd, ctx.sessionManager);
		startPermissionState(permission, provenance, ctx, event.reason);
		applyBashEnvironmentSetting();
		applySessionSandbox(permission, ctx);
	});
	const localReads = registerReadReceipts(api);
	// After the receipts: it reads the files they credit.
	registerNestedContext(api);
	// Every result, nested tool calls included, before any later call can repeat its text.
	api.bus.on("tool_result", async (event, ctx) => provenance.record(agentOperation(event), ctx));
	recordChildReports(api, provenance, permission, isSubagent, attachmentTexts);
	connectGuard(guard, team);
	const checkpoints = new Checkpoints();
	const fileHooks: FileReplacementOwner = {
		enabled: (input, cwd) => later.get("hooks").hasFilePermissionRequest(input, cwd),
		committed: (id, input, cwd) => later.get("hooks").fileInputCommitted(id, input, cwd),
		refresh: (ctx) => later.get("sourcePolicy").refresh(ctx),
	};
	registerFileTool(api, guard, permission, checkpoints, fileHooks, attachmentContent);
	// Octocode's bash with a foreground deadline and background jobs.
	const jobs = registerBashTool(api, commands, undefined, undefined, jobLinks);
	// `octocode-agent-<role>-<id>` process title, periodic memory samples, and `/processes`.
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
	registerTeamSessions(api, team, checkpoints, { commands, isSubagent, serving: () => agents?.serving() ?? [] });
	composeBacklog(api, {
		commands,
		isSubagent,
		team,
		stop: (to) => agents?.stop(to, "user") ?? (agents ? undefined : "Agent controls are unavailable."),
		completing: (info, ctx, signal) => later.get("hooks").taskCompleted(info, ctx, signal),
		serving: () => agents?.serving() ?? new Map(),
		review: (request, ctx, signal) =>
			agents?.review(request, ctx, signal) ?? Promise.resolve({ skipped: "agent controls are unavailable" }),
	});
	registerMemory(api, {
		commands,
		isSubagent,
		permission,
		goal: process.env[AGENT_GOAL_ENV],
		small: { call: callSmallModel, label: smallModelLabel },
	});
	commands.add(
		"status",
		statusCommand(api, permission, () =>
			[
				`Octocode ${packageVersion() ?? ""}`.trim(),
				`Subagents: ${[...profiles.keys()].join(", ") || "none"} (at most ${maxSubagents(process.env)} at once)`,
				`Hooks: ${later.get("hooks").summary()}`,
				// The registered commands, so a child session lists only its own; `/mcp` belongs to its own feature.
				`Commands: ${[...commands.list().map(([name]) => name), "mcp"].map((name) => `/${name}`).join(", ")}`,
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
				notice: (content) => void sendPeerNotice(api, "octocode-peer-notice", content),
				quiet: (content) => void team.notice(content),
				ownName: () => agentNameOf(api).get(),
				members: () => team.members(),
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
		...collaborationPorts(),
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
		registerRender(api, { isSubagent });
		registerConfigurationTool(api, { permission, isSubagent });
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
		registerMessagesCommand(commands, (ctx) => liveMessagesData(ctx, team));
		// A user's narrowing mode change names the running subagents it would stop and asks first.
		permission.setConfirmStop(stopConfirmation(() => agents?.running() ?? [], isSubagent));
		registerModels(commands, () => profiles);
		registerModelsTool(
			api,
			() => profiles,
			async (ctx, _signal, filters) => [
				...runnerRows(runners.states, filters),
				...(agentTool.has("external") ? await externalListing(external, ctx, filters) : []),
			],
		);
	} else if (runners.ids.length > 0 && !envFlag(process.env, LEAN_ENV)) {
		// A lean child's `agent` reaches its parent and teammates only: it starts no runner task.
		registerChildRunnerTask(runners, permission, agentTool.collect, team);
	}
	const skillCatalog = SkillCatalog.forSession(() => api.resources.getSkillResourceSnapshot(), isSubagent);
	registerSkills(api, skillCatalog);
	registerPromptOptimization(commands, api);
	registerUi(api, isSubagent);
	registerWake(api);
	// Tool calls that outlast their foreground budget continue as jobs and report to this session.
	registerAsyncJobs(api);
	registerStallRecorder(api);
	// What the agent does now: Octocode's working line (main session) and the team panel's activity column (every agent).
	const activity = registerActivity(api, { workingLine: !isSubagent, onChange: (line) => team.setActivity(line) });
	// Every call a permission check lets through (full mode asks nothing) shows as a short line while its tool runs.
	permission.onAction((event) => activity.consequential(event.action, event.what, event.warn));
	const turn = registerTurnSetup(api, {
		isSubagent,
		skillCatalog,
		profiles: () => profiles,
	});
	const { hooks, sourcePolicy, messaging } = composePolicy(api, {
		later,
		permission,
		planning,
		provenance,
		team,
		guard,
	});
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
	registerCompactTool(
		api,
		registerCompaction(
			api,
			guard,
			isSubagent,
			team.parentId,
			awaitsAnswer(isSubagent, () => (team.id === undefined ? 0 : team.unansweredPeerAsks(team.id))),
		),
		isSubagent,
	);
	registerDeferredSchemaRestore(api);
	if (isSubagent) registerChildSession(api);
	registerArchiveCommand(commands);
	registerArchiveTool(api, { isSubagent });
	const closeArchive = registerArchiveLifecycle(api, {
		canProject: () => !planning.blocked() && !envFlag(process.env, READ_ONLY_ENV),
		agentId: () => team.id,
		parentId: () => team.parentId,
	});
	registerSkillFirstUse(api, registerSkillTool(api, skillCatalog));
	const runGuards = registerRunGuards(api, isSubagent); // after the file guard: see run-guards.ts
	registerHarnessCommand(commands, hooks, api);
	// Subagents have no terminal of their own: their parent's row and report carry their state. A child follows the parent's `/harness` switches instead.
	if (isSubagent) registerHarnessSync(api);
	else registerNotify(api, { onNotice: hooks.notification });
	// After `registerProcesses`, which titles the process: an alert wakes the session whose title owns its cause.
	registerMonitor(api, { isSubagent, jobs: () => [...jobs.jobs.values()], notify: hooks.notification });
	registerMonitorRoom(commands, api);
	registerUsage(api, commands); // spend by day (every session, children too) and `/usage`
	const externalApi = isSubagent
		? undefined
		: registerExternalApi(api, commands, { team, messaging, permission, planning, external: () => external });
	api.bus.on("session_start", async (_event, ctx) => {
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
		peerSessions: checkoutSharers(team),
	});
	registerNativeSessionLifecycle(api, {
		isSubagent,
		team,
		permission,
		jobs,
		agents,
		external,
		api: externalApi,
		commands,
	});
	api.bus.on("session_shutdown", async () => closeArchive());
	// Register each native command once, after every feature has supplied its handler.
	commands.register(api);
}
