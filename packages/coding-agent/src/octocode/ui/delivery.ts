import { GLYPH } from "@octocodeai/octocode-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { notify } from "../shared/commands.ts";
import { plural } from "../shared/render/text.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { STATUS } from "../shared/status.ts";

type Send = ExtensionAPI["sendMessage"];
type Message = Parameters<Send>[0];
type Options = Parameters<Send>[1];

/**
 * Keeps extension messages (subagent reports, background job reports, teammate messages) that `api.sendMessage` queued
 * during a run from being lost.
 *
 * While a run is active, a message that may start a turn joins Octocode's steering or follow-up queue. Octocode shows only the
 * user's own queued text, and when the user presses Esc (or dequeues) it clears the whole queue but puts back only
 * that text. This ledger records each queued message by its `details` object, which Octocode keeps on the message it later
 * starts. A message still unstarted when the run settles was dropped. In the TUI, the only place that clears the
 * queue, it is appended to the conversation without starting a turn: the user interrupted, so nothing restarts, but
 * nothing is lost. A status segment shows how many messages wait meanwhile.
 *
 * Installed on `api` itself, before any feature registers, so every `api.sendMessage` call goes through it. Messages
 * without a details object, `nextTurn` messages and `triggerTurn: false` messages are not queued this way and pass
 * through untracked.
 */
export class Delivery {
	private readonly waiting = new Map<object, { message: Message; accepted?: Promise<void> }>();
	private running = false;
	private ctx: ExtensionContext | undefined;
	private generation = 0;

	private readonly send: Send;
	constructor(send: Send) {
		this.send = send;
	}

	static install(api: ExtensionAPI): Delivery {
		const delivery = new Delivery(api.sendMessage.bind(api));
		(api as { sendMessage: Send }).sendMessage = (message, options) => delivery.deliver(message, options);
		api.on("session_start", async (_event, ctx) => delivery.reset(ctx));
		api.on("session_shutdown", async () => delivery.reset(undefined));
		api.on("agent_start", async (_event, ctx) => {
			delivery.ctx = ctx;
			delivery.running = true;
		});
		api.on("message_start", async (event) => {
			const { message } = event;
			if (message.role === "custom" && isRecord(message.details) && delivery.waiting.delete(message.details))
				delivery.paint();
		});
		api.on("agent_settled", async (_event, ctx) => delivery.settle(ctx));
		return delivery;
	}

	/** Messages queued and not started yet. */
	get pending(): number {
		return this.waiting.size;
	}

	deliver(message: Message, options?: Options): ReturnType<Send> {
		// Octocode queues once a run starts preparing, before `agent_start` (its `before_agent_start` handlers run in between).
		const busy = this.running || this.preparing();
		const sent = this.send(message, options);
		const queued = busy && options?.triggerTurn !== false && options?.deliverAs !== "nextTurn";
		if (!queued || !isRecord(message.details)) return sent;
		const details = message.details;
		const accepted = sent && typeof sent.then === "function" ? Promise.resolve(sent) : undefined;
		const entry = { message, accepted };
		this.waiting.set(details, entry);
		this.paint();
		if (!accepted) return sent;
		const generation = this.generation;
		const result = accepted.catch((error: unknown) => {
			if (generation === this.generation && this.waiting.get(details) === entry) {
				this.waiting.delete(details);
				this.paint();
			}
			throw error;
		});
		// Some extension notices intentionally fire and forget; keep their rejection observable to awaiting callers.
		void result.catch(() => {});
		return result;
	}

	/** A run is starting but has not reached `agent_start`. */
	private preparing(): boolean {
		try {
			return this.ctx !== undefined && !this.ctx.isIdle();
		} catch {
			// The session was replaced.
			return false;
		}
	}

	/** The run is over: Octocode starts queued messages before it settles, so any still waiting were cleared. */
	private async settle(ctx: ExtensionContext): Promise<void> {
		this.running = false;
		this.ctx = ctx;
		const generation = this.generation;
		const dropped = [...this.waiting.values()];
		this.waiting.clear();
		this.paint();
		// Outside the TUI nothing clears the queue: an aborted run leaves the messages there for the next one.
		if (dropped.length === 0 || ctx.mode !== "tui") return;
		let kept = 0;
		const failures: string[] = [];
		for (const { message, accepted } of dropped) {
			try {
				await accepted;
			} catch {
				// The original handoff failed; its caller receives the rejection and owns recovery.
				continue;
			}
			if (generation !== this.generation) return;
			try {
				await this.send(message, { triggerTurn: false });
				if (generation !== this.generation) return;
				kept += 1;
			} catch (error) {
				if (generation !== this.generation) return;
				// The session ended meanwhile: this message is lost, and the notice says so.
				failures.push(errorMessage(error));
			}
		}
		if (!ctx.hasUI) return;
		try {
			if (kept > 0)
				notify(
					ctx.ui,
					`Interrupt kept ${plural(kept, "queued message")}: added to the conversation without starting a turn.`,
					"info",
				);
			if (failures.length > 0)
				notify(
					ctx.ui,
					`Interrupt lost ${plural(failures.length, "queued message")}: could not add ${failures.length === 1 ? "it" : "them"} to the conversation (${failures[0]}).`,
					"warning",
				);
		} catch {
			// The session was replaced: nobody is left to tell.
		}
	}

	private reset(ctx: ExtensionContext | undefined): void {
		this.generation++;
		this.waiting.clear();
		this.running = false;
		// The new session's UI is painted (a replaced session's status clears through it); a shutdown clears its own UI.
		if (ctx) this.ctx = ctx;
		this.paint();
		this.ctx = ctx;
	}

	private paint(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(
				STATUS.queued,
				this.waiting.size > 0 ? `${GLYPH.message} ${this.waiting.size} queued` : undefined,
				"accent",
			);
		} catch {
			// The session was replaced.
		}
	}
}
