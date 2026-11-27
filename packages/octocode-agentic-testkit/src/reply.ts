import type { Usage } from "./trace.ts";

/** Why a reply ended other than a normal answer or tool call: a token limit or a refusal. */
export type StopReason = "max_tokens" | "refusal";

/** What the gateway answers with, independent of the wire protocol. */
export interface Reply {
	text: string;
	toolCalls: { id: string; name: string; arguments: string }[];
	usage: Usage;
	/** The wire response id's suffix, unique per request; the gateway sets it when it sends the reply. */
	id?: string;
	/** Set when the reply ended on a token limit or a refusal; senders map it to each wire's stop field. */
	stop?: StopReason;
	/**
	 * The upstream's own content and stop reason on its wire: Anthropic content blocks, or Responses output items. The
	 * sender of the same wire replays them verbatim, so thinking blocks keep their signatures, reasoning items their
	 * encrypted content, and server-tool blocks survive. Cleared when a guard rewrites the reply.
	 */
	raw?: { wire: "anthropic" | "responses"; content: Record<string, unknown>[]; stopReason?: string };
}
