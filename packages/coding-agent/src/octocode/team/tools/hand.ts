import type { FeatureContext } from "../../../core/features/index.ts";

/** A `sendMessage` call's fields, `item` aside. */
export interface SendParams {
	to?: string;
	message?: string;
	attach?: string;
	forward?: number;
	replyRequired?: boolean;
	wake?: boolean;
	replyTo?: number;
	interrupt?: boolean;
}

/** What `sendMessage` returns: its text and details. */
type SendResult = { content: { type: "text"; text: string }[]; details: unknown };

/** A handed item: the notice the child reads first, what the coordinator is told, and how to take it back. */
export interface Handoff {
	notice: string;
	summary: string;
	undo(): void;
}

/** Hands backlog item `ref` to running child `child` (wired by `index.ts` from the subagents domain). */
export type HandItem = (child: string, ref: string, ctx: FeatureContext) => Handoff;

/**
 * `agent` `message` with `item`: hands the item to the one running child `to` names, then sends the message with the
 * item's notice in front. A failed send takes the item back from the child (a claim the hand-over made stays with this
 * session). The reply ends with what the hand-over did: the claim, the child's context fill, shared paths.
 */
export async function handAndSend(
	hand: HandItem | undefined,
	params: SendParams,
	ref: string,
	ctx: FeatureContext,
	send: (params: SendParams) => Promise<SendResult>,
): Promise<SendResult> {
	if (!hand) throw new Error("Only the agent that started a subagent can hand it an item. Nothing was sent.");
	const child = params.to?.trim();
	if (!child || child === "all" || child === "parent")
		throw new Error("item goes to one running subagent you started: name it in to. Nothing was sent.");
	if (params.forward !== undefined) throw new Error("item goes with a new message, not a forward. Nothing was sent.");
	const handoff = hand(child, ref.trim(), ctx);
	let result: SendResult;
	try {
		const message = params.message ? `${handoff.notice}\n\n${params.message}` : handoff.notice;
		result = await send({ ...params, to: child, message });
	} catch (error) {
		handoff.undo();
		throw error;
	}
	const text = result.content.map((part) => part.text).join("");
	return { ...result, content: [{ type: "text", text: `${text} ${handoff.summary}` }] };
}
