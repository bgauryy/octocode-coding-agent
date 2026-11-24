import { displayText } from "../../../render/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { recordProblem } from "../../../../core/diagnostics-log.ts";
import { Type } from "typebox";
import type { FeatureSetup, SetupPick, FeatureContext } from "../../../../core/features/index.ts";
import { MAX_COMPACTION_INSTRUCTIONS } from "../../../../core/compaction/manual-options.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { limitsFor } from "../../../compaction/limits.ts";
import { autoCompactAt, compactionThinking } from "../../../shared/tokens.ts";
import { timedTool } from "../../../render/rows.ts";
import { isStaleSessionError, textResult } from "../../../shared/util.ts";
import { type CompactDetails, compactHeader, compactResult } from "../../../compaction/compact-render.ts";
import { contextTokens, type ThrashBreaker, toolDefinitionChars } from "../../../compaction/pacing.ts";

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

export const COMPACT_RESUME_TEXT = renderPrompt("notices/compaction/compact-done.md");

/** How every refusal starts: the display tells a refusal from a failure by it. */
const REFUSED = "Compaction refused";
/** Ends a refusal that leaves the agent nothing to change; the display leaves it out. */
const CONTINUE = renderPrompt("tools/compact/continue.md");
const refusalText = (name: string, values: Record<string, string | number | boolean> = {}, goOn = false): string => {
	const text = renderPrompt(`tools/compact/refused-${name}.md`, { refused: REFUSED, ...values });
	return goOn ? `${text} ${CONTINUE}` : text;
};

/**
 * The hidden message that resumes the task after the agent's compaction. A summary written ahead of the request (the
 * early summary, `early-summary.ts`) did not see its focus, so the focus follows it here, labelled as the agent's own.
 */
function compactResumeText(result: { details?: unknown } | undefined, focus: string | undefined): string {
	const focusDetails = isRecord(result?.details) ? result.details.focus : undefined;
	const followUp = focus !== undefined && isRecord(focusDetails) && focusDetails.delivery === "follow-up";
	return followUp
		? `${COMPACT_RESUME_TEXT}\n\n${renderPrompt("tools/compact/focus-follow-up.md", { focus })}`
		: COMPACT_RESUME_TEXT;
}

interface Pending {
	focus?: string;
	/** Compactions counted when the request was made: a later one already did the job. */
	compactions: number;
}

export class CompactRequests {
	readonly #thrash: ThrashBreaker;
	#pending: Pending | undefined;
	#active: Pending | undefined;
	#compactions = 0;
	/** Set by `registerCompactTool`: subagents never have the tool. */
	toolRegistered = false;

	constructor(thrash: ThrashBreaker) {
		this.#thrash = thrash;
	}

	/** Whether the compaction now running was requested by the agent (it counts as automatic). */
	get inFlight(): boolean {
		return this.#active !== undefined;
	}

	get pending(): boolean {
		return this.#pending !== undefined;
	}

	reset(): void {
		this.#pending = undefined;
		this.#active = undefined;
	}

	compacted(): void {
		this.#compactions += 1;
	}

	/** The refusal for a request now, if any. */
	refusal(
		api: SetupPick<"tools", "getActive" | "getAll"> &
			SetupPick<"models", "getThinkingLevel"> &
			SetupPick<"settings", "get">,
		ctx: Pick<FeatureContext, "model" | "getContextUsage" | "getSystemPrompt" | "sessionManager">,
	): string | undefined {
		const thrash = this.#thrash;
		if (thrash.tripped()) return refusalText("thrash");
		const since = thrash.turnsSinceCompaction;
		if (since !== undefined && since < COMPACT_COOLDOWN_TURNS)
			return refusalText("cooldown", { thisTurn: since === 0 }, true);
		const model = ctx.model;
		const tokens = contextTokens(ctx, toolDefinitionChars(api));
		if (!model || model.contextWindow <= 0 || tokens === undefined) return refusalText("unknown");
		const limit = autoCompactAt(model, compactionThinking(api), limitsFor(api, model).compaction);
		if (tokens < COMPACT_MIN_SHARE * limit) {
			// Rounded down: 49.6% must not read as the 50% floor it is refused under.
			const percent = Math.floor((tokens / Math.max(1, limit)) * 100);
			return refusalText("small", { percent, floor: COMPACT_MIN_SHARE * 100 }, true);
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
		api: SetupPick<"session", "sendMessage">,
		ctx: Pick<FeatureContext, "compact" | "hasUI">,
		aborted: boolean,
	): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending || aborted || pending.compactions !== this.#compactions) return;
		this.#active = pending;
		const send = (content: string, triggerTurn: boolean) => {
			if (this.#active !== pending) return;
			this.#active = undefined;
			// A stale session has no reader for the resume note; any other failure goes to the problems log.
			const settle = (error: unknown) => {
				if (!isStaleSessionError(error))
					recordProblem("compact", `Compact resume note not sent: ${errorMessage(error)}`);
			};
			try {
				void Promise.resolve(
					api.session.sendMessage({ customType: COMPACT_RESUME_TYPE, content, display: false }, { triggerTurn }),
				).catch(settle);
			} catch (error) {
				if (!isStaleSessionError(error)) throw error;
			}
		};
		ctx.compact({
			customInstructions: pending.focus,
			// The agent's own request: its focus is labelled as its own, and it may reuse the early summary.
			requestedBy: "agent",
			onComplete: (result) => {
				send(compactResumeText(result, pending.focus), true);
			},
			// The session reports the failure to the user; the model learns of it on its next turn, without a new one. A
			// headless run has no next turn: its last reply was the status line it was told to end with, so it goes on from here.
			onError: (error) => {
				send(renderPrompt("notices/compaction/compact-failed.md", { error: errorMessage(error) }), !ctx.hasUI);
			},
		});
	}
}

/** Registers the tool for the main agent only (see above); `requests` comes from `registerCompaction`. */
export function registerCompactTool(api: FeatureSetup, requests: CompactRequests, isSubagent: boolean): void {
	if (isSubagent) return;
	requests.toolRegistered = true;
	api.tools.register(
		timedTool({
			name: COMPACT_TOOL,
			roleVariant: true,
			label: "Compact",
			promptSnippet: renderPrompt("tools/compact/snippet.md"),
			description: renderPrompt("tools/compact/description.md"),
			parameters: Type.Object({
				// No schema bound (tool schemas carry none, `schema-shape.test`): the length is applied in `execute`.
				focus: Type.Optional(
					Type.String({ description: "What you need next: next step, open questions, files in work" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (requests.pending)
					return textResult(renderPrompt("tools/compact/already-queued.md"), {
						queued: true,
						already: true,
					} satisfies CompactDetails);
				const refusal = requests.refusal(api, ctx);
				if (refusal) throw new Error(refusal);
				const focus = params.focus?.trim() || undefined;
				// Refused whole, not cut: a focus cut at the limit would drop what the agent asked the summary to keep.
				if (focus && focus.length > MAX_COMPACTION_INSTRUCTIONS)
					throw new Error(refusalText("focus", { chars: focus.length, limit: MAX_COMPACTION_INSTRUCTIONS }));
				requests.request(focus);
				return textResult(renderPrompt("tools/compact/queued.md"), { queued: true } satisfies CompactDetails);
			},
			display(input) {
				const focus = typeof input.args?.focus === "string" ? input.args.focus.trim() : "";
				const head = { title: "Compact", ...(focus ? { summary: focus } : {}), kind: "think" as const, blocks: [] };
				if (!input.result) return head;
				if (input.status === "failed") {
					const shown = displayText(input.result).replace(/\s+/g, " ").trim();
					const text = (shown.endsWith(CONTINUE) ? shown.slice(0, -CONTINUE.length) : shown).trim();
					const refused = text.startsWith(REFUSED);
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
