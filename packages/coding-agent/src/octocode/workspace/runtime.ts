import type { ApplicationService } from "../../core/application/index.ts";
import { appendWorkspaceEvent, createWorkspaceRuntimeState } from "../../core/application/workspace-state.ts";
import { ApplicationCommands } from "./application-commands.ts";
import { presentAgentReport } from "../subagents/presentation.ts";
import { dbStamp, type AgentDb } from "../../../../db/src/api.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { workingContextTokens } from "../../core/agent-session/model-control.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { RevisedWorkspace } from "./revision.ts";
import { WorkspaceCommands } from "./commands.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { doItPrompt, delegatePrompt } from "../backlog/actions.ts";
import type { Backlog } from "../backlog/context.ts";
import type { Team } from "../team/session.ts";
import { involvedHistory, readHistory } from "./team-history.ts";
import { teamScope } from "../team/store/workspace.ts";
import { departedLookup } from "../team/feed-read.ts";
import { HEARTBEAT_MS } from "../team/session/activity.ts";
import { memberWorktree } from "../worktree-paths/member-worktree.ts";
import { descendants } from "../team/panel/roster.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { WorkspaceEvent, WorkspaceReceipt } from "@octocodeai/octocode-contracts/workspace";
import { AGENT_RESULT_TYPE } from "../shared/messages.ts";
import { redactData, redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { contentText } from "../shared/util.ts";
import { toolHint } from "../../utils/tool-hint.ts";
import { agentBase, createProfiler, endedRuns, memberTranscript, sessionTranscript } from "../profiler/index.ts";
import { storedSilences } from "../profiler/silences.ts";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";

interface Operations {
	application?: (ctx: FeatureContext) => ApplicationService | undefined;
	database?: () => AgentDb;
	members(): Member[];
	/** The coordinator's own team row (the session's agent, which `members()` leaves out). */
	self?(): Member | undefined;
	traffic(): Traffic[];
	/** Whether a message involves this session or its agents; the team's history is shared by every session. */
	involves?(): (message: Traffic) => boolean;
	tell(to: string, text: string, signal?: AbortSignal): Promise<unknown>;
	stop(to: string): string | undefined;
	/**
	 * Changes whenever time alone can change `members()` or `traffic()` (liveness and recent traffic expire without a
	 * database write). Without it the snapshot cannot be stamped and the server compares serialized snapshots.
	 */
	expiry?(): string;
}

/**
 * The team inputs of a workspace snapshot, with the expiry stamp the team's own view uses (it re-reads each heartbeat).
 * The team database is shared by every session in the workspace, so, like the terminal panel, the web view lists only
 * this session's descendants (`descendants`) and the messages that involve this session or them.
 */
export function teamView(
	team: Team,
	withSelf = false,
): Pick<Operations, "members" | "traffic" | "involves" | "expiry" | "self"> {
	const involves = () => {
		const mine = new Set(descendants(team.snapshot().members, team.id).map((member) => member.id));
		if (team.id) mine.add(team.id);
		return (message: Traffic) => mine.has(message.from) || message.to.some((id) => mine.has(id));
	};
	return {
		...(withSelf ? { self: () => team.members().find((member) => member.id === team.id) } : {}),
		members: () => {
			const all = team.members();
			const home = all.find((member) => member.id === team.id)?.checkout;
			return descendants(all, team.id).map((member) => {
				const worktree = memberWorktree(member, home);
				return worktree ? { ...member, worktree } : member;
			});
		},
		traffic: () => {
			const { traffic } = team.snapshot();
			return traffic.filter(involves());
		},
		involves,
		expiry: () => String(Math.trunc(Date.now() / HEARTBEAT_MS)),
	};
}

/** Adapts the running session to interfaces; execution and permissions remain owned by the agent runtime. */
export class WorkspaceRuntime {
	private readonly state = createWorkspaceRuntimeState();
	private get sessionId(): string | undefined {
		return this.state.getState().sessionId;
	}
	private sessionController = new AbortController();
	private readonly subscriptions = new Set<() => void>();
	private readonly projectedApplications = new WeakSet<ApplicationService>();
	/** Counts changes to the event list; one of the inputs of a snapshot's `revision`. */
	private eventsVersion = 0;

	private readonly api: FeatureSetup;
	private readonly operations: Operations;
	constructor(api: FeatureSetup, operations: Operations) {
		this.api = api;
		this.operations = operations;
		this.state.subscribe((state, previous) => {
			if (state.events !== previous.events) this.eventsVersion++;
		});
		api.bus.on("session_start", (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (this.sessionId !== sessionId || this.sessionController.signal.aborted) {
				this.sessionController.abort(new Error("Session changed before delivery finished."));
				this.sessionController = new AbortController();
			}
			this.application(ctx);
			this.state.setState({ sessionId, events: [] });
			this.publish("session", "Session started");
		});
		api.bus.on("agent_start", () => this.publish("agent.start", "Agent working"));
		api.bus.on("agent_settled", (event) =>
			this.publish("agent.settled", event.aborted ? "Agent stopped" : "Agent settled"),
		);
		api.bus.on("tool_execution_start", (event, ctx) => {
			if (this.application(ctx)) return;
			const hint = toolHint(event.args);
			this.publish("tool.start", event.toolName, { id: event.toolCallId, ...(hint ? { hint } : {}) });
		});
		api.bus.on("tool_execution_update", (event, ctx) => {
			if (this.application(ctx)) return;
			if (event.toolName === "agent")
				this.publish("agent.progress", contentText(event.partialResult.content), event.partialResult.details);
		});
		api.bus.on("tool_execution_end", (event, ctx) => {
			if (this.application(ctx)) return;
			const result = asRecord(event.result);
			this.publish(
				"tool.result",
				`${event.toolName}${event.isError ? " failed" : ""}\n${contentText(result.content)}`,
				result.details,
				event.isError ? "failed" : "succeeded",
			);
		});
		api.bus.on("message_end", (event, ctx) => {
			if (event.message.role === "assistant" && this.application(ctx)) return;
			if (event.message.role === "assistant" || event.message.role === "custom") {
				const message = event.message;
				const details = "details" in message ? message.details : undefined;
				if (message.role === "custom" && message.customType === AGENT_RESULT_TYPE) {
					const report = presentAgentReport(message.content, asRecord(details));
					const outcome = report.structured
						? report.structured.status === "valid" && report.status === "done" && report.outcome === "done"
							? "succeeded"
							: "failed"
						: undefined;
					this.publish("agent.result", report.summary + "\n" + report.body, report, outcome);
				} else this.publish("message", contentText(message.content), details);
			}
		});
		api.bus.on("session_shutdown", () => {
			this.sessionController.abort(new Error("Session closed before delivery finished."));
			for (const unsubscribe of this.subscriptions) unsubscribe();
			this.subscriptions.clear();
			this.state.setState({ sessionId: undefined, events: [] });
		});
	}

	private application(ctx: FeatureContext): ApplicationService | undefined {
		const application = this.operations.application?.(ctx);
		if (application && !this.projectedApplications.has(application)) {
			application.setToolOutputProjector((toolName, result) => {
				if (
					(toolName !== "agent" && toolName !== AGENT_RESULT_TYPE) ||
					!isRecord(result) ||
					!isRecord(result.details) ||
					!result.details.structured
				)
					return undefined;
				const report = presentAgentReport(result.content, result.details);
				return `${report.summary}\n${report.body}`;
			});
			this.projectedApplications.add(application);
		}
		return application;
	}

	private publish(type: string, text: string, details?: unknown, outcome?: WorkspaceEvent["outcome"]): void {
		let safe: unknown;
		try {
			safe = details === undefined ? undefined : redactData(details);
		} catch {
			safe = undefined;
		}
		appendWorkspaceEvent(this.state, {
			at: Date.now(),
			type,
			...(outcome ? { outcome } : {}),
			text:
				redactSecrets(text).slice(0, 16000) +
				(text.length > 16000 ? "\n[Long output shortened; the full result remains in the session transcript.]" : ""),
			...(safe !== undefined && JSON.stringify(safe).length < 32000 ? { details: safe } : {}),
		});
	}

	/** The application promise settles after queuing or running; acceptance is never a claim of task completion. */
	private observeDelivery(
		delivery: Promise<void>,
		commands: WorkspaceCommands,
		request: WorkspaceReceipt,
		sessionId: string,
		signal: AbortSignal,
	): void {
		void delivery.catch(async (error: unknown) => {
			const message = `Agent request failed: ${redactSecrets(errorMessage(error)).slice(0, 1000)}. ${request.backlogId} remains claimed; inspect activity before retrying.`;
			try {
				const receipt = await commands.finish(request.id, "failed", message);
				if (!signal.aborted && this.sessionId === sessionId) this.publish("command", message, receipt, "failed");
			} catch {
				if (!signal.aborted && this.sessionId === sessionId)
					this.publish("command", `${message} The delivery outcome could not be saved.`, undefined, "failed");
			}
		});
	}

	bind(ctx: FeatureContext, backlog: Backlog): RevisedWorkspace {
		const sessionId = ctx.sessionManager.getSessionId();
		const application = this.application(ctx);
		application?.setReceiptStore(
			new ApplicationCommands((this.operations.database ?? sharedAgentDb)(), backlog.store.repo),
		);
		const commands = new WorkspaceCommands(
			(this.operations.database ?? sharedAgentDb)(),
			backlog.store.repo,
			sessionId,
		);
		if (!this.sessionId) this.state.setState({ sessionId });
		let closed = false;
		const signal = this.sessionController.signal;
		const subscribed = new Set<() => void>();
		const active = () => {
			if (
				closed ||
				signal.aborted ||
				this.sessionId !== sessionId ||
				(application && application.sessionId !== sessionId)
			)
				throw new Error("This session changed. Reopen /octocode.");
		};
		const database = () => (this.operations.database ?? sharedAgentDb)();
		// Agents that finished leave the team but stay in the profiler, read from their stored runs.
		const ended = endedRuns(database, sessionId);
		let departed: ReturnType<typeof departedLookup> | undefined;
		const profiler = createProfiler({
			sessionId,
			self: () => {
				const self = this.operations.self?.();
				return self ? { ...agentBase(self), role: "main" } : undefined;
			},
			coordinatorFile: () => ctx.sessionManager.getSessionFile(),
			members: () => {
				const live = this.operations.members();
				const skip = new Set(live.map((member) => member.id));
				const selfId = this.operations.self?.()?.id;
				if (selfId) skip.add(selfId);
				return [...live.map(agentBase), ...ended.members(skip)];
			},
			traffic: () => this.operations.traffic(),
			silences: (ids) => storedSilences(database().db, ids),
			sessionTranscript: (id) => sessionTranscript(database().db, id),
			history: (limit, before) => {
				const involves = this.operations.involves?.();
				if (!involves) throw new Error("This session cannot tell which messages involve it.");
				return involvedHistory(readHistory(database().db, teamScope(ctx.cwd, process.env)), involves, limit, before);
			},
			// Message ends resolve against this session's agents, then the row an agent left when it ended.
			endpoints: () => {
				const self = this.operations.self?.();
				departed ??= departedLookup(database().db);
				return {
					members: [...(self ? [self] : []), ...this.operations.members()],
					departed,
					...(self?.checkout ? { root: self.checkout } : {}),
				};
			},
			transcript: (id) => {
				const member = this.operations.members().find((each) => each.id === id);
				return member ? memberTranscript(database().db, member) : ended.transcript(id);
			},
			// Agents compact against their working budget, not the catalog capacity (core/agent-session/model-control.ts).
			contextWindowOf: (provider, model) => {
				const own = ctx.model;
				if (own?.provider === provider && own.id === model) return own.contextWindow;
				const capacity = ctx.modelRegistry.find(provider, model)?.contextWindow;
				return capacity ? workingContextTokens(capacity, SETTINGS_DEFAULTS.contextBudget) : undefined;
			},
		});
		return {
			application,
			profiler,
			/**
			 * Stamps every input of `snapshot`: the events (counted here), receipts, members and traffic (the shared
			 * database file; every writer moves it), and expiry by time. Undefined when `operations.expiry` is missing.
			 */
			revision: () => {
				active();
				const expiry = this.operations.expiry?.();
				if (expiry === undefined) return undefined;
				return `${this.eventsVersion}|${dbStamp((this.operations.database ?? sharedAgentDb)().file)}|${expiry}`;
			},
			snapshot: () => {
				active();
				return {
					sessionId,
					agents: redactData(this.operations.members()),
					traffic: redactData(this.operations.traffic()),
					events: redactData([...this.state.getState().events]),
					receipts: commands.list(),
				};
			},
			subscribe: (listener) => {
				active();
				const stop = this.state.subscribe((state, previous) => {
					if (state.events === previous.events) return;
					try {
						listener();
					} catch {
						/* A closed view must not interrupt the session. */
					}
				});
				const unsubscribe = () => {
					stop();
					subscribed.delete(unsubscribe);
					this.subscriptions.delete(unsubscribe);
				};
				subscribed.add(unsubscribe);
				this.subscriptions.add(unsubscribe);
				return unsubscribe;
			},
			close: () => {
				closed = true;
				profiler.close();
				for (const unsubscribe of subscribed) unsubscribe();
			},
			execute: async (command) => {
				active();
				const existing = await commands.begin(command, signal);
				if (!existing.fresh) return existing.receipt;
				let receipt: WorkspaceReceipt;
				try {
					const item = command.backlogId ? backlog.store.get(command.backlogId) : undefined;
					if (command.backlogId && !item) throw new Error("That backlog item no longer exists.");
					if (item && command.version !== item.version) throw new Error("This item changed. Reopen it before sending.");
					let message: string;
					if (command.action === "work" || command.action === "delegate") {
						if (!item) throw new Error("Choose a backlog item first.");
						backlog.store.dispatch(item.ref, item.version, { ...backlog.actor, kind: "human" }, (claimed) => {
							const prompt =
								command.action === "delegate"
									? delegatePrompt(claimed, backlog.store)
									: doItPrompt(claimed, backlog.store);
							if (application)
								this.observeDelivery(
									application.invoke("sendUserMessage", prompt, { deliverAs: "followUp" }),
									commands,
									existing.receipt,
									sessionId,
									signal,
								);
							else this.api.session.sendUserMessage(prompt, { deliverAs: "followUp" });
						});
						message =
							command.action === "delegate"
								? "Delegation requested from the current agent. Launch permissions still apply; watch activity for the new agent."
								: "Work queued for the current agent.";
					} else if (command.action === "message") {
						if (!command.to || !command.text?.trim()) throw new Error("Choose an agent and write a message.");
						if (!this.operations.members().some((member) => member.id === command.to))
							throw new Error("That agent is no longer available.");
						const sent = await this.operations.tell(
							command.to,
							`${item ? `Backlog ${item.ref}: ${item.title}\n\n` : ""}${command.text}`,
							signal,
						);
						if (isRecord(sent) && sent.error)
							throw new Error(typeof sent.error === "string" ? sent.error : JSON.stringify(sent.error));
						message = "Message accepted for delivery. Follow its delivery status in Agents.";
					} else {
						if (!command.to) throw new Error("Choose an agent to stop.");
						// The list is already scoped to this session's agents; refuse any other id here too, not only hide it.
						if (!this.operations.members().some((member) => member.id === command.to))
							throw new Error("That agent is not one of this session's agents.");
						const refused = this.operations.stop(command.to);
						if (refused) throw new Error(refused);
						message = "Stop requested.";
					}
					receipt = await commands.finish(command.id, "accepted", message);
				} catch (error) {
					receipt = await commands.finish(command.id, "failed", redactSecrets(errorMessage(error)));
				}
				if (!signal.aborted && this.sessionId === sessionId) this.publish("command", receipt.message, receipt);
				return receipt;
			},
		};
	}
}
