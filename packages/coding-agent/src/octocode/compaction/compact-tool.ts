import { displayText } from "../render/display.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { MAX_COMPACTION_INSTRUCTIONS } from "../../core/compaction/manual-options.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { autoCompactAt, compactionThinking } from "../shared/tokens.ts";
import { timedTool } from "../render/rows.ts";
import { isStaleSessionError, textResult } from "../shared/util.ts";
import { type CompactDetails, compactHeader, compactResult } from "./compact-render.ts";
import { contextTokens, type ThrashBreaker, toolDefinitionChars } from "./pacing.ts";

/**
 * The main agent's own compaction request. The tool only queues it: `compact()` aborts the running session first, so
 * it runs once the run settles, and a hidden message then resumes the task from the summary. It counts as automatic for
 * the thrash breaker, and is refused while the context is small or right after a compaction. Subagents do not get it:
 * a child's run settling is its report.
 */
export const COMPACT_TOOL = "compact";
/** Below this share of the room before automatic compaction, a summary frees too little to pay for itself. */
const COMPACT_MIN_SHARE = 0.5;
/** A request this few turns after the previous compaction is refused (an automatic one may still refill). */
const COMPACT_COOLDOWN_TURNS = 2;
export const COMPACT_RESUME_TYPE = "octocode-compact-resume";

export const COMPACT_RESUME_TEXT = renderInstruction("notices/compaction/compact-done.md");

interface Pending {
	focus?: string;
	/** Compactions counted when the request was made: a later one already did the job. */
	compactions: number;
}

export class CompactRequests {
	readonly #thrash: ThrashBreaker;
	#pending: Pending | undefined;
	#inFlight = false;
	#compactions = 0;
	/** Set by `registerCompactTool`: subagents never have the tool. */
	toolRegistered = false;

	constructor(thrash: ThrashBreaker) {
		this.#thrash = thrash;
	}

	/** Whether the compaction now running was requested by the agent (it counts as automatic). */
	get inFlight(): boolean {
		return this.#inFlight;
	}

	get pending(): boolean {
		return this.#pending !== undefined;
	}

	reset(): void {
		this.#pending = undefined;
		this.#inFlight = false;
	}

	compacted(): void {
		this.#compactions += 1;
	}

	/** The refusal for a request now, if any. */
	refusal(
		api: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel" | "getSettings">,
		ctx: Pick<ExtensionContext, "model" | "getContextUsage" | "getSystemPrompt" | "sessionManager">,
	): string | undefined {
		const thrash = this.#thrash;
		if (thrash.tripped())
			return "Compaction refused: the context refilled right after each of the last compactions, so another summary would not make room. Reduce the large inputs, or ask the user to start a new session.";
		const since = thrash.turnsSinceCompaction;
		if (since !== undefined && since < COMPACT_COOLDOWN_TURNS)
			return `Compaction refused: the context was compacted ${since === 0 ? "in this turn" : "one turn ago"}. Continue the task.`;
		const model = ctx.model;
		const tokens = contextTokens(ctx, toolDefinitionChars(api));
		if (!model || model.contextWindow <= 0 || tokens === undefined)
			return "Compaction refused: the context size is unknown.";
		const limit = autoCompactAt(model, compactionThinking(api));
		if (tokens < COMPACT_MIN_SHARE * limit) {
			// Rounded down: 49.6% must not read as the 50% floor it is refused under.
			const percent = Math.floor((tokens / Math.max(1, limit)) * 100);
			return `Compaction refused: the context is ${percent}% of the room before automatic compaction, under ${COMPACT_MIN_SHARE * 100}%, so a summary would free little. Continue the task.`;
		}
		return undefined;
	}

	request(focus: string | undefined): void {
		this.#pending = { focus, compactions: this.#compactions };
	}

	/**
	 * After a run settles: runs the pending request, then resumes the task with a hidden message. A run the user stopped
	 * drops it, and so does a compaction that already ran since the request.
	 */
	settle(
		api: Pick<ExtensionAPI, "sendMessage">,
		ctx: Pick<ExtensionContext, "compact" | "hasUI">,
		aborted: boolean,
	): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending || aborted || pending.compactions !== this.#compactions) return;
		this.#inFlight = true;
		const send = (content: string, triggerTurn: boolean) => {
			try {
				void api.sendMessage({ customType: COMPACT_RESUME_TYPE, content, display: false }, { triggerTurn });
			} catch (error) {
				if (!isStaleSessionError(error)) throw error;
			}
		};
		ctx.compact({
			customInstructions: pending.focus,
			onComplete: () => {
				this.#inFlight = false;
				send(COMPACT_RESUME_TEXT, true);
			},
			// The session reports the failure to the user; the model learns of it on its next turn, without a new one. A
			// headless run has no next turn: its last reply was the status line it was told to end with, so it goes on from here.
			onError: (error) => {
				this.#inFlight = false;
				send(renderInstruction("notices/compaction/compact-failed.md", { error: errorMessage(error) }), !ctx.hasUI);
			},
		});
	}
}

/** Registers the tool for the main agent only (see above); `requests` comes from `registerCompaction`. */
export function registerCompactTool(api: ExtensionAPI, requests: CompactRequests, isSubagent: boolean): void {
	if (isSubagent) return;
	requests.toolRegistered = true;
	api.registerTool(
		timedTool({
			name: COMPACT_TOOL,
			label: "Compact",
			promptSnippet: renderInstruction("tools/compact/snippet.md"),
			description:
				"Summarize older turns to free context once this reply ends; the task then resumes from the summary, so end your reply after calling it.",
			parameters: Type.Object({
				// No schema bound (tool schemas carry none, `schema-shape.test`): the length is applied in `execute`.
				focus: Type.Optional(
					Type.String({ description: "What you need after the summary: next step, open questions, files in work" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (requests.pending)
					return textResult("Compaction is already queued for the end of this reply. End your reply now.", {
						queued: true,
						already: true,
					} satisfies CompactDetails);
				const refusal = requests.refusal(api, ctx);
				if (refusal) throw new Error(refusal);
				const focus = params.focus?.trim() || undefined;
				// Refused whole, not cut: a focus cut at the limit would drop what the agent asked the summary to keep.
				if (focus && focus.length > MAX_COMPACTION_INSTRUCTIONS)
					throw new Error(
						`Compaction refused: focus is ${focus.length} characters, over the limit of ${MAX_COMPACTION_INSTRUCTIONS}. Shorten it and call again.`,
					);
				requests.request(focus);
				return textResult(
					"Compaction queued: it runs when this reply ends, and the task resumes from the summary. End your reply now with a one-line status.",
					{ queued: true } satisfies CompactDetails,
				);
			},
			display(input) {
				const focus = typeof input.args?.focus === "string" ? input.args.focus.trim() : "";
				const head = { title: "Compact", ...(focus ? { summary: focus } : {}), kind: "think" as const, blocks: [] };
				if (!input.result) return head;
				if (input.status === "failed") {
					const text = displayText(input.result)
						.replace(/\s+/g, " ")
						.replace(/\s*Continue the task\.$/, "")
						.trim();
					const refused = text.startsWith("Compaction refused");
					return {
						...head,
						outcome: { text, tone: refused ? "warning" : "error", ...(refused ? { stopped: true as const } : {}) },
					};
				}
				const details = input.result.details as Partial<CompactDetails> | undefined;
				return {
					...head,
					outcome: {
						text: `${details?.already ? "Already queued" : "Queued"} \u00b7 runs when this reply ends`,
						tone: "muted",
					},
				};
			},
			renderCall: (args, theme, context) => compactHeader(theme, context, args),
			renderResult: (result, _options, theme, context) => compactResult(result, theme, context),
		}),
	);
}
