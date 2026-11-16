import type { Usage } from "./trace.ts";

/** What the gateway answers with, independent of the wire protocol. */
export interface Reply {
	text: string;
	toolCalls: { id: string; name: string; arguments: string }[];
	usage: Usage;
}
