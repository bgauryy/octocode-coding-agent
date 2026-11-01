import type { ApplicationService } from "../../core/application/index.ts";
import { appendWorkspaceEvent, createWorkspaceRuntimeState } from "../../core/application/workspace-state.ts";
import { ApplicationCommands } from "./application-commands.ts";
import { presentAgentReport } from "../subagents/presentation.ts";
import { dbStamp, sharedAgentDb, type AgentDb } from "../agentdb/api.ts";
import type { RevisedWorkspace } from "./revision.ts";
import { WorkspaceCommands } from "./commands.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { doItPrompt, delegatePrompt } from "../backlog/actions.ts";
import type { Backlog } from "../backlog/context.ts";
import type { Team } from "../team/session.ts";
import { HEARTBEAT_MS } from "../team/session/activity.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { WorkspaceEvent, WorkspaceReceipt } from "@octocodeai/octocode-contracts/workspace";
import { AGENT_RESULT_TYPE } from "../shared/messages.ts";
import { redactData, redactSecrets } from "../../../../common/src/sanitize.ts";
import { contentText, toolHint } from "../shared/util.ts";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";

interface Operations {
	application?: (ctx: ExtensionContext) => ApplicationService | undefined;
	database?: () => AgentDb;
	members(): Member[];
	traffic(): Traffic[];
	tell(to: string, text: string, signal?: AbortSignal): Promise<unknown>;
	stop(to: string): string | undefined;
	/**
	 * Changes whenever time alone can change `members()` or `traffic()` (liveness and recent traffic expire without a
	 * database write). Without it the snapshot cannot be stamped and the server compares serialized snapshots.
	 */
	expiry?(): string;
}

/** The team inputs of a workspace snapshot, with the expiry stamp the team's own view uses (it re-reads each heartbeat). */
export function teamView(team: Team): Pick<Operations, "members" | "traffic" | "expiry"> {
	return {
		members: () => team.members(),
		traffic: () => team.snapshot().traffic,
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

	private readonly api: ExtensionAPI;
	private readonly operations: Operations;
	constructor(api: ExtensionAPI, operations: Operations) {
		this.api = api;
		this.operations = operations;
		this.state.subscribe((state, previous) => {
			if (state.events !== previous.events) this.eventsVersion++;
		});
		api.on("session_start", (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (this.sessionId !== sessionId || this.sessionController.signal.aborted) {
				this.sessionController.abort(new Error("Session changed before delivery finished."));
				this.sessionController = new AbortController();
			}
			this.application(ctx);
			this.state.setState({ sessionId, events: [] });
			this.publish("session", "Session started");
		});
		api.on("agent_start", () => this.publish("agent.start", "Agent working"));
		api.on("agent_settled", (event) =>
			this.publish("agent.settled", event.aborted ? "Agent stopped" : "Agent settled"),
		);
		api.on("tool_execution_start", (event, ctx) => {
			if (this.application(ctx)) return;
			const hint = toolHint(event.args);
			this.publish("tool.start", event.toolName, { id: event.toolCallId, ...(hint ? { hint } : {}) });
		});
		api.on("tool_execution_update", (event, ctx) => {
			if (this.application(ctx)) return;
			if (event.toolName === "agent")
				this.publish("agent.progress", contentText(event.partialResult.content), event.partialResult.details);
		});
		api.on("tool_execution_end", (event, ctx) => {
			if (this.application(ctx)) return;
			const result = asRecord(event.result);
			this.publish(
				"tool.result",
				`${event.toolName}${event.isError ? " failed" : ""}\n${contentText(result.content)}`,
				result.details,
				event.isError ? "failed" : "succeeded",
			);
		});
		api.on("message_end", (event, ctx) => {
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
		api.on("session_shutdown", () => {
			this.sessionController.abort(new Error("Session closed before delivery finished."));
			for (const unsubscribe of this.subscriptions) unsubscribe();
			this.subscriptions.clear();
			this.state.setState({ sessionId: undefined, events: [] });
		});
	}

	private application(ctx: ExtensionContext): ApplicationService | undefined {
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
		void delivery.catch((error: unknown) => {
			const message = `Agent request failed: ${redactSecrets(errorMessage(error)).slice(0, 1000)}. ${request.backlogId} remains claimed; inspect activity before retrying.`;
			try {
				const receipt = commands.finish(request.id, "failed", message);
				if (!signal.aborted && this.sessionId === sessionId) this.publish("command", message, receipt, "failed");
			} catch {
				if (!signal.aborted && this.sessionId === sessionId)
					this.publish("command", `${message} The delivery outcome could not be saved.`, undefined, "failed");
			}
		});
	}

	bind(ctx: ExtensionContext, backlog: Backlog): RevisedWorkspace {
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
		return {
			application,
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
				for (const unsubscribe of subscribed) unsubscribe();
			},
			execute: async (command) => {
				active();
				const existing = commands.begin(command);
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
							else this.api.sendUserMessage(prompt, { deliverAs: "followUp" });
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
						const refused = this.operations.stop(command.to);
						if (refused) throw new Error(refused);
						message = "Stop requested.";
					}
					receipt = commands.finish(command.id, "accepted", message);
				} catch (error) {
					receipt = commands.finish(command.id, "failed", redactSecrets(errorMessage(error)));
				}
				if (!signal.aborted && this.sessionId === sessionId) this.publish("command", receipt.message, receipt);
				return receipt;
			},
		};
	}
}
