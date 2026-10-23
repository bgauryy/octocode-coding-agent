import { AGENT_ID_ENV, AGENT_ROLE_ENV } from "./team/store.ts";
import { webCommand } from "./workspace/command.ts";
import { getApplicationPortForSession } from "../core/application/index.ts";
import { startWorkspaceWeb } from "./workspace/server.ts";
import { WorkspaceRuntime } from "./workspace/runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/index.ts";
import { registerMcpReconnect } from "../extensions/mcp/status.ts";
import { agentModes, agentOperation } from "./agent-tool.ts";
import { closeSharedAgentDb } from "./agentdb/db.ts";
import { registerApi } from "./api/register.ts";
import { registerAskUser } from "./ask/tool.ts";
import { registerBacklog } from "./backlog/index.ts";
import { BrowserTool, registerBrowserTool } from "./browser/tool.ts";
import { registerArchiveCommand } from "./compaction/archive-command.ts";
import { registerArchiveTool } from "./compaction/archive-tool.ts";
import { registerCompaction } from "./compaction/register.ts";
import { registerDebugTool } from "./debug/tool.ts";
import type { ExternalAgents } from "./external/manager.ts";
import { externalPermissionDialog } from "./external/permission-dialog.ts";
import { registerExternal } from "./external/register.ts";
import { registerBashTool } from "./files/bash.ts";
import { Checkpoints } from "./files/checkpoint.ts";
import { registerCheckpoints } from "./files/checkpoint-command.ts";
import { registerReadDedupe } from "./files/dedupe.ts";
import { registerReadReceipts } from "./files/read-receipts.ts";
import { contextReads } from "./files/reads.ts";
import { BASH_READER, FileGuard, LOCAL_FETCH_READER, registerFileTool } from "./files/tool.ts";
import { registerHooks, registerHooksCommand } from "./hooks/register.ts";
import { reconnectOctocodeMcp, registerOctocodeMcp } from "./mcp/octocode.ts";
import { registerMemory } from "./memory/register.ts";
import { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import { Permission } from "./permission/ask.ts";
import { registerPermissionCommand } from "./permission/command.ts";
import { PROFILE_DECLARABLE } from "./permission/mode.ts";
import { createProvenance } from "./permission/provenance.ts";
import { pruneSnapshots } from "./permission/snapshot.ts";
import { shellMutation, shellParserReady } from "./permission/shell/mutation.ts";
import { stopConfirmation } from "./permission/stop-confirm.ts";
import { registerSessions } from "./sessions/register.ts";
import { notify, Subcommands } from "./shared/commands.ts";
import { envFlag, SUBAGENT_ENV } from "./shared/env.ts";
import { setCurrentSession } from "./shared/home.ts";
import { interactive } from "./shared/interactive.ts";
import { withDialog } from "./shared/locks.ts";
import { EXTERNAL_SENDER, type MessageEnvelope } from "./shared/messages.ts";
import { plural, stopRowTimers } from "./shared/render.ts";
import { projectTrust, registerTrustCommand } from "./shared/trust.ts";
import { errorMessage, firstLine, MINUTE_MS, settleWithin } from "./shared/util.ts";
import { windowsTree } from "./shared/winhelper.ts";
import { registerSkills } from "./skills.ts";
import { statusCommand } from "./status-command.ts";
import { currentCatalog } from "./subagents/catalog.ts";
import { maxSubagents } from "./subagents/claim.ts";
import { registerModelsCommand } from "./subagents/models-command.ts";
import { type AgentProfile, loadProfiles, profileFileName } from "./subagents/profiles.ts";
import { type AgentControl, registerAgentTool } from "./subagents/tool.ts";
import { spilledMessage, Team } from "./team/session.ts";
import { registerCollab } from "./team/tools.ts";
import { registerToolGates } from "./tool-gates.ts";
import { registerTurnSetup } from "./turn.ts";
import { registerActivity } from "./ui/activity.ts";
import { packageVersion, registerUi } from "./ui/chrome.ts";
import { Delivery } from "./ui/delivery.ts";
import { registerEditor } from "./ui/editor.ts";
import { registerNotify } from "./ui/notify.ts";
import { registerWebTool } from "./web/web.ts";

/**
 * Native Octocode features build on the core tools, skills, sessions, MCP
 * and compaction: guarded file edits, the Octocode MCP server (its own
 * MCP client), subagents, web and browser tools, askUser and a focused prompt.
 *
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
 *
 * Native features register direct commands; core merges shared status, model and trust views.
 */
export default function octocode(pi: ExtensionAPI, options: { mcp?: boolean } = {}): void {
	const isSubagent = envFlag(process.env, SUBAGENT_ENV);
	// First, so every feature's pi.sendMessage goes through it and its agent_settled handler runs before theirs.
	Delivery.install(pi);
	const commands = new Subcommands();
	const guard = new FileGuard();
	const team = new Team(pi);
	let profiles = new Map<string, AgentProfile>();
	/** Why each profile file was refused at load (`loadProfiles`' `onSkip`), by file name: the `agent` tool names it for an unknown profile. */
	let refused = new Map<string, string>();
	const octocodeMcp = registerOctocodeMcp(pi, packageVersion(), options.mcp !== false, (unavailable) => {
		guard.reader = unavailable ? BASH_READER : LOCAL_FETCH_READER;
	});
	const unregisterMcpReconnect = registerMcpReconnect(pi.events, "octocode", reconnectOctocodeMcp(octocodeMcp));
	pi.on("session_shutdown", async () => {
		unregisterMcpReconnect();
	});
	// One permission state per session: the mode, its grants, and the provenance tripwire's index.
	const permission = new Permission({ pi, isSubagent, agent: () => team.id });
	const annotations = (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.annotations;
	const provenance = createProvenance({ annotations });

	pi.on("session_start", async (_event, ctx) => {
		// Before anything writes output: spilled results, bash logs and checkpoints go to this session's folder.
		setCurrentSession(ctx.sessionManager.getSessionId());
		// Every start (resume and fork included) re-applies the start mode, so `full` never comes back silently.
		permission.start(ctx);
		provenance.clear();
		// Restore points older than a week go; off the start path, and never an error for the session.
		void pruneSnapshots(ctx.cwd);
	});
	const localReads = registerReadReceipts(pi);
	// Every result, nested tool calls included, before any later call can repeat its text.
	pi.on("tool_result", async (event, ctx) => provenance.record(agentOperation(event), ctx));

	guard.reservedBy = (file) => team.reservation(file, file);
	const checkpoints = new Checkpoints();
	registerFileTool(
		pi,
		guard,
		permission,
		checkpoints,
		{
			enabled: (input, cwd) => hooks.hasFilePermissionRequest(input, cwd),
			committed: (id, input) => hooks.fileInputCommitted(id, input),
			refresh: (ctx) => sourcePolicy.refresh(ctx),
		},
		{ enabled: envFlag(process.env, "OCTOCODE_EDIT_DIAGNOSTICS", true) },
	);
	// Octocode's bash with a foreground deadline and background jobs.
	const jobs = registerBashTool(pi, commands);
	let agents: AgentControl | undefined;
	let external: ExternalAgents | undefined;
	// /new, /resume and /fork end this runtime, and with it its bash jobs and background subagents: ask before leaving
	// them. Registered before the checkpoint handlers, so a fork is confirmed before its file-restore offer.
	const confirmLeave = async (ctx: ExtensionContext, action: string) => {
		if (!interactive(ctx, isSubagent)) return undefined;
		const running = [
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
	pi.on("session_before_switch", async (event, ctx) =>
		confirmLeave(ctx, event.reason === "new" ? "start a new session" : "switch sessions"),
	);
	pi.on("session_before_fork", async (_event, ctx) => confirmLeave(ctx, "fork"));
	registerCheckpoints(pi, checkpoints, (file) => guard.forget(file), commands);
	registerSessions(pi, {
		commands,
		isSubagent,
		filesChanged: () => new Set(checkpoints.list().map((entry) => entry.path)).size,
	});
	const workspace = isSubagent
		? undefined
		: new WorkspaceRuntime(pi, {
				application: (ctx) => getApplicationPortForSession(ctx.sessionManager.getSessionId()),
				members: () => team.members(),
				traffic: () => team.snapshot().traffic,
				tell: (to, text, signal) => team.send(to, text, { from: "user", signal }),
				stop: (to) => agents?.stop(to, "user") ?? (agents ? undefined : "Agent controls are unavailable."),
			});
	const openWorkspace = registerBacklog(pi, {
		commands,
		isSubagent,
		agentId: () => team.id,
		openWeb: (ctx, backlog, changed) => startWorkspaceWeb(backlog, changed, workspace?.bind(ctx, backlog)),
	});
	if (!isSubagent) commands.add("web", webCommand(openWorkspace));
	registerMemory(pi, { commands, isSubagent, permission });
	const skillCount = () => pi.getCommands().filter((command) => command.source === "skill").length;
	commands.add("status", statusCommand(pi));
	registerWebTool(pi, permission);
	registerBrowserTool(pi, new BrowserTool(permission));
	registerDebugTool(pi);
	const agentTool = agentModes();
	const collab = registerCollab(pi, team, {
		stopAgent: isSubagent ? undefined : (id, by) => agents?.stop(id, by),
		beforeLeave: async (reason) => agents?.stopAll(reason),
		registerTool: agentTool.collect,
		shellWrites: async (command) => {
			await shellParserReady();
			return shellMutation(command).writes;
		},
	});
	if (!isSubagent) {
		registerPermissionCommand(commands, permission, () => provenance.size());
		registerEditor(pi, permission);
		registerTrustCommand(commands);
		registerAskUser(pi);
		agents = registerAgentTool(
			pi,
			() => profiles,
			team,
			permission,
			() => refused,
			agentTool.collect,
		);
		commands.add("agents", agents.command);
		// A user's narrowing mode change names the running subagents it would stop and asks first.
		permission.setConfirmStop(stopConfirmation(() => agents?.running() ?? [], isSubagent));
		registerModelsCommand(commands, () => profiles);
	}
	registerSkills(pi);
	registerUi(pi, isSubagent);
	// What the agent does now: Octocode's working line (main session) and the team panel's activity column (every agent).
	const activity = registerActivity(pi, { workingLine: !isSubagent, onChange: (line) => team.setActivity(line) });
	// Every call a permission check lets through (full mode asks nothing) shows as a short line while its tool runs.
	permission.onAction((event) => activity.consequential(event.action, event.what, event.warn));
	const turn = registerTurnSetup(pi, { isSubagent, profiles: () => profiles, octocode: octocodeMcp });
	const hooks = registerHooks(
		pi,
		process.env,
		undefined,
		(what, note, allowed) => permission.noted(what, note, { allowed, via: "hook" }),
		() => ({
			permissionMode: permission.mode,
			agentName: process.env[AGENT_ID_ENV],
			agentType: process.env[AGENT_ROLE_ENV],
		}),
	);
	const sourcePolicy = registerSourcePolicy(pi, process.env, undefined, () =>
		permission.setSourcePolicy(sourcePolicy.evaluate, sourcePolicy.unprojected),
	);
	if (sourcePolicy.enabled) permission.setSourcePolicy(sourcePolicy.evaluate, sourcePolicy.unprojected);
	permission.setResolver((ctx, invocation, signal) =>
		hooks.permissionRequest(invocation, ctx as ExtensionContext, signal),
	);
	permission.setUpdateHandler(async (ctx, updates, signal) => {
		await sourcePolicy.refresh(ctx as ExtensionContext);
		signal.throwIfAborted();
		return sourcePolicy.prepareUpdates(ctx as ExtensionContext, updates);
	});
	const beforeMessage = async (message: MessageEnvelope, ctx: ExtensionContext, signal?: AbortSignal) => {
		const verdict = await hooks.messageSend(message, signal ? { ...ctx, signal } : ctx);
		if (verdict?.block) {
			permission.refused([`${message.from} → ${message.to}`], verdict.block, "message");
			throw new Error(verdict.block);
		}
		if (verdict?.ask) {
			const checked = await permission.check(ctx, {
				title: "Send this message?",
				what: [`${message.from} → ${message.to}`, message.text],
				reasons: ["hook.ask"],
				reason: verdict.ask,
				...(signal ? { signal } : {}),
			});
			if (!checked.allowed) throw new Error(checked.message);
		}
		signal?.throwIfAborted();
	};
	team.setMessageHook(beforeMessage);
	if (!isSubagent) {
		external = registerExternal(
			pi,
			commands,
			{
				sender: (ctx) => team.id ?? ctx.sessionManager.getSessionId(),
				beforeSend: beforeMessage,
				afterReceive: (message, ctx) => hooks.messageReceive(message, ctx),
				authorize: async (input, ctx, signal) => {
					const checked = await permission.check(ctx, {
						action: "agent.spawn",
						title: input.action === "connect" ? "Connect this external agent?" : "Send this external prompt?",
						what: [JSON.stringify(input)],
						cwd: input.cwd ?? ctx.cwd,
						signal,
						effect: "The external agent uses its own credentials, tools and permission policy.",
					});
					if (!checked.allowed) throw new Error(checked.message);
				},
				permission: externalPermissionDialog,
			},
			agentTool.collect,
		);
		permission.onRevoke(() => {
			void external?.reset();
		});
	}
	agentTool.register(pi);
	// After the hooks (handlers run in registration order): a PreCompact hook runs before Octocode adds its `file` tool's
	// paths to the file lists Octocode carries into its summary. Octocode writes the summary itself.
	registerCompaction(pi, guard, isSubagent);
	registerArchiveCommand(commands);
	registerArchiveTool(pi);
	// After the file guard's `tool_result` handler (`registerFileTool`), which must digest the text a read returned.
	registerReadDedupe(pi);
	registerHooksCommand(commands, hooks);
	// Subagents have no terminal of their own: their parent's row and report carry their state.
	if (!isSubagent) registerNotify(pi, { onNotice: (notice, ctx) => hooks.notification(notice, ctx) });
	const api = isSubagent
		? undefined
		: registerApi(
				pi,
				commands,
				{
					list: () => team.members(),
					tell: (to, text) => team.send(to, text, { from: EXTERNAL_SENDER }),
					deliverable: spilledMessage,
				},
				packageVersion,
				{
					messageSend: beforeMessage,
					externalCall: (input, ctx) => external!.call(input, ctx),
				},
			);

	pi.on("session_start", async (_event, ctx) => {
		// Per-session state first: a later step that throws (API port in use) must not carry the old session's over.
		turn.reset();
		await external?.reset();
		// Reads in a resumed, reloaded or forked session's context still count; a new session starts empty.
		guard.restore(contextReads(ctx));
		const skipped: string[] = [];
		refused = new Map();
		const shadowed: string[] = [];
		profiles = loadProfiles(
			ctx.cwd,
			undefined,
			await projectTrust(ctx),
			process.env,
			(file, error) => {
				skipped.push(`${file}: ${errorMessage(error)}`);
				refused.set(profileFileName(file), errorMessage(error));
			},
			(name, file, replaced) => shadowed.push(`${name}: ${file} replaces ${replaced}`),
		);
		if (shadowed.length > 0 && interactive(ctx, isSubagent))
			notify(ctx.ui, `Project subagent profiles replace profiles loaded earlier:\n${shadowed.join("\n")}`, "warning");
		if (skipped.length > 0 && interactive(ctx, isSubagent))
			notify(ctx.ui, `Skipped subagent profiles that could not be read:\n${skipped.join("\n")}`, "warning");
		const ignored = [...profiles.values()].filter((profile) => profile.ignoredPermissions?.length);
		if (ignored.length > 0 && interactive(ctx, isSubagent))
			notify(
				ctx.ui,
				`Ignored permissions a subagent profile cannot declare (only ${PROFILE_DECLARABLE.join(", ")}):\n${ignored.map((profile) => `${profile.name}: ${profile.ignoredPermissions!.join(", ")}`).join("\n")}`,
				"warning",
			);
		await api?.start(ctx);
		// The models.dev index, refreshed in the background, so the first subagent of the day routes with it.
		if (!isSubagent) currentCatalog();
	});

	// The tool-call pipeline, its cleanup and the user's own `!cmd` (`tool-gates.ts`).
	registerToolGates(pi, { permission, provenance, annotations, collab, hooks, sourcePolicy, activity, localReads });

	// Headless runs (print, JSON, subagents) end with the agent's run, which would lose background work before it reports:
	// hold the run until bash jobs and background subagents finish (their reports arrive as one more turn). An interactive
	// session goes on; an aborted or failed run has no turn to hand the reports to.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (interactive(ctx, isSubagent) || event.outcome !== "completed") return undefined;
		// ctx.signal is unset once the model's run is over; an interrupt for this agent ends the wait too.
		const stop = ctx.signal ? AbortSignal.any([ctx.signal, team.interrupted]) : team.interrupted;
		// No time cap of its own: jobs without a timeout are stopped, timed jobs end at their timeout, and a subagent's
		// watchdog bounds it by its calls' deadlines; an interrupt ends the wait. Job and child handles are unref'd, so a
		// ref'd timer keeps the process alive until their reports arrive.
		const keepAlive = setInterval(() => undefined, MINUTE_MS);
		try {
			await settleWithin(Promise.all([jobs.settle(), agents?.settle()]), undefined, stop);
		} finally {
			clearInterval(keepAlive);
		}
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		permission.shutdown(ctx);
		// Rows of the old session that were still running would otherwise tick every second for the life of the process.
		stopRowTimers();
		await api?.stop();
		await external?.reset();
		// Every reason: a new, resumed, forked or reloaded session imports this module again, so this connection would never be reused.
		closeSharedAgentDb();
		// After the subagents and bash jobs (their own shutdown handlers ran first): the helper that holds their Windows job objects can end.
		await windowsTree.stopAll();
	});

	// Register each native command once, after every feature has supplied its handler.
	commands.register(pi, () => {
		return [
			`Octocode ${packageVersion() ?? ""}`.trim(),
			firstLine(octocodeMcp.describe()),
			`Subagents: ${[...profiles.keys()].join(", ") || "none"} (at most ${maxSubagents()} at once)`,
			`Skills: ${skillCount()}`,
			`Hooks: ${hooks.summary()}`,
			// The registered commands, so a child session lists only its own; `/mcp` belongs to the MCP extension.
			`Commands: ${[...commands.list().map(([name]) => name), "mcp"].map((name) => `/${name}`).join(", ")}`,
		].join("\n");
	});
}
