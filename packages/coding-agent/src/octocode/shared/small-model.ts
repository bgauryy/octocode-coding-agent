import type { Usage } from "@octocodeai/octocode-ai";

/** A reply's text, the `provider/id` that wrote it and what the call used and cost (so a caller can record the spend). */
export type SmallCallResult =
	| { text: string; model: string; provider: string; modelId: string; usage: Usage }
	| { error: string };

/**
 * The `small` purpose's caller (`subagents/small-call.ts`), which the composition root hands to the features that ask a
 * cheaper model (`timer/` judgments, `memory/` passes), so they do not import `subagents/`. Tests script it. `Context`
 * is the session's feature context, which each feature names (`shared/` reaches no host type).
 */
export interface SmallModel<Context> {
	/** One tool-less call to the cheaper model; never rejects (an `error` names the cause). */
	call(ctx: Context, options: { text: string; signal: AbortSignal; maxTokens: number }): Promise<SmallCallResult>;
	/** The `provider/id` the route resolves to for this session, or undefined when no cheaper model exists. */
	label(ctx: Context): string | undefined;
}
