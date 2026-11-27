import type { McpContext } from "./types.ts";

/** One value a server asks the user for, as the host shows it. Its texts come from the server, with controls made visible. */
export interface McpElicitationField {
	/** The property the answer is sent under. */
	name: string;
	/** What to call the field: the server's title for it, else its name, on one line. */
	label: string;
	description?: string;
	type: "string" | "number" | "integer" | "boolean";
	/** The only values a string field takes, each with the text to show for it. */
	options?: readonly { value: string; label: string }[];
	required: boolean;
}

/** A server's request for input from the user (MCP elicitation, form mode). */
export interface McpElicitationRequest {
	server: string;
	/** The server's own words about what it wants: untrusted. */
	message: string;
	fields: readonly McpElicitationField[];
	/** Why the previous answer to this request was not sent; the host shows it when it asks again. */
	problem?: string;
	/** Aborted when the server withdraws the request or the tool call it belongs to ends. */
	signal: AbortSignal;
	/** The context of the tool call that was waiting on the server when it asked. */
	ctx: McpContext;
}

/** The user's values by field name (a field left empty is absent), a refusal, or a dismissal. */
export type McpElicitationAnswer =
	| { action: "accept"; content: Record<string, string | number | boolean> }
	| { action: "decline" | "cancel" };

/**
 * Asks the user what a server requested. Optional: without it no server is told the client takes such requests. The
 * host answers `decline` where nobody can be asked, and `cancel` when the user dismissed the question.
 */
export interface McpElicitationPort {
	ask(request: McpElicitationRequest): Promise<McpElicitationAnswer>;
}
