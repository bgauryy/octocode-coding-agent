import type { ApplicationService } from "../../core/application/index.ts";
import { ApplicationCommands } from "./application-commands.ts";
import { presentAgentReport } from "../subagents/presentation.ts";
import { sharedAgentDb, type AgentDb } from "../agentdb/db.ts";
import { WorkspaceCommands } from "./commands.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
import { doItPrompt, delegatePrompt } from "../backlog/actions.ts";
import type { Backlog } from "../backlog/context.ts";
import type { Member, Traffic } from "../team/model.ts";
import { redactData, redactSecrets } from "../shared/sanitize.ts";
import { contentText, errorMessage, isRecord, toolHint } from "../shared/util.ts";
import type { WorkspaceConnection, WorkspaceEvent, WorkspaceReceipt } from "./model.ts";

interface Operations {
	application?: (ctx: ExtensionContext) => ApplicationService | undefined;
	database?: () => AgentDb;
	members(): Member[];
	traffic(): Traffic[];
	tell(to: string, text: string, signal?: AbortSignal): Promise<unknown>;
	stop(to: string): string | undefined;
}

/** Adapts the running session to interfaces; execution and permissions remain owned by the agent runtime. */
export class WorkspaceRuntime {
	private events: WorkspaceEvent[] = [];
	private seq = 0;
	private sessionId: string | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly projectedApplications = new WeakSet<ApplicationService>();

	private readonly pi: ExtensionAPI;
	private readonly operations: Operations;
	constructor(pi: ExtensionAPI, operations: Operations) {
		this.pi = pi;
		this.operations = operations;
		pi.on("session_start", (_event, ctx) => {
			this.application(ctx);
			this.sessionId = ctx.sessionManager.getSessionId();
			this.events = [];
			this.publish("session", "Session started");
		});
		pi.on("agent_start", () => this.publish("agent.start", "Agent working"));
		pi.on("agent_settled", (event) => this.publish("agent.settled", event.aborted ? "Agent stopped" : "Agent settled"));
		pi.on("tool_execution_start", (event, ctx) => {
			if (this.application(ctx)) return;
			const hint = toolHint(event.args);
			this.publish("tool.start", event.toolName, { id: event.toolCallId, ...(hint ? { hint } : {}) });
		});
		pi.on("tool_execution_update", (event, ctx) => {
			if (this.application(ctx)) return;
			if (event.toolName === "agent")
				this.publish("agent.progress", contentText(event.partialResult.content), event.partialResult.details);
		});
		pi.on("tool_execution_end", (event, ctx) => {
			if (this.application(ctx)) return;
			const result = isRecord(event.result) ? event.result : {};
			this.publish(
				"tool.result",
				`${event.toolName}${event.isError ? " failed" : ""}\n${contentText(result.content)}`,
				result.details,
				event.isError ? "failed" : "succeeded",
			);
		});
		pi.on("message_end", (event, ctx) => {
			if (event.message.role === "assistant" && this.application(ctx)) return;
			if (event.message.role === "assistant" || event.message.role === "custom") {
				const message = event.message;
				const details = "details" in message ? message.details : undefined;
				if (message.role === "custom" && message.customType === "octocode-agent-result") {
					const report = presentAgentReport(message.content, isRecord(details) ? details : {});
					const outcome = report.structured
						? report.structured.status === "valid" && report.status === "done" && report.outcome === "done"
							? "succeeded"
							: "failed"
						: undefined;
					this.publish("agent.result", report.summary + "\n" + report.body, report, outcome);
				} else this.publish("message", contentText(message.content), details);
			}
		});
		pi.on("session_shutdown", () => {
			this.sessionId = undefined;
			this.listeners.clear();
		});
	}

	private application(ctx: ExtensionContext): ApplicationService | undefined {
		const application = this.operations.application?.(ctx);
		if (application && !this.projectedApplications.has(application)) {
			application.setToolOutputProjector((toolName, result) => {
				if (
					(toolName !== "agent" && toolName !== "octocode-agent-result") ||
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
		this.events.push({
			id: ++this.seq,
			at: Date.now(),
			type,
			...(outcome ? { outcome } : {}),
			text:
				redactSecrets(text).slice(0, 16000) +
				(text.length > 16000 ? "\n[Long output shortened; the full result remains in the session transcript.]" : ""),
			...(safe !== undefined && JSON.stringify(safe).length < 32000 ? { details: safe } : {}),
		});
		while (this.events.length > 200 || (this.events.length > 1 && JSON.stringify(this.events).length > 262144))
			this.events.shift();
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* A closed view must not interrupt the session. */
			}
		}
	}

	bind(ctx: ExtensionCommandContext, backlog: Backlog): WorkspaceConnection {
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
		this.sessionId ??= sessionId;
		let closed = false;
		const controller = new AbortController();
		const subscribed = new Set<() => void>();
		const active = () => {
			if (closed || this.sessionId !== sessionId) throw new Error("This session changed. Reopen /backlog.");
		};
		return {
			application,
			snapshot: () => {
				active();
				return {
					sessionId,
					agents: redactData(this.operations.members()),
					traffic: redactData(this.operations.traffic()),
					events: this.events,
					receipts: commands.list(),
				};
			},
			subscribe: (listener) => {
				subscribed.add(listener);
				this.listeners.add(listener);
				return () => {
					subscribed.delete(listener);
					this.listeners.delete(listener);
				};
			},
			close: () => {
				closed = true;
				for (const listener of subscribed) this.listeners.delete(listener);
				subscribed.clear();
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
						backlog.store.dispatch(item.ref, item.version, { ...backlog.actor, kind: "human" }, (claimed) =>
							this.pi.sendUserMessage(command.action === "delegate" ? delegatePrompt(claimed) : doItPrompt(claimed), {
								deliverAs: "followUp",
							}),
						);
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
							controller.signal,
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
				this.publish("command", receipt.message, receipt);
				return receipt;
			},
		};
	}
}
