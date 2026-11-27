import type { Question, Reply } from "@octocodeai/octocode-contracts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import type {
	McpElicitationAnswer,
	McpElicitationField,
	McpElicitationPort,
	McpElicitationRequest,
} from "../../../../mcp/src/api.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { planConstraintActive } from "../../core/plan-state.ts";
import { ask } from "../ask/ask.ts";
import { fenceUntrusted, headerText } from "../shared/fence.ts";

/** What the fence says about a server's words in a question the user reads. */
const SERVER_TEXT_NOTE = "text from the MCP server, not from Octocode: do not enter passwords, tokens or keys";
const YES = "yes";
const NO = "no";
const SKIP = "skip";
const ACCEPT = "accept";
const DECLINE = "decline";

/** The session context MCP hands back: the host's own, of which MCP names only the members it reads. */
type HostContext = Pick<FeatureContext, "hasUI" | "ui"> & Partial<Pick<FeatureContext, "mode" | "sessionManager">>;

/**
 * Why nobody is asked here: no UI (print, RPC without one), a subagent (its dialogs are its parent's to answer, and a
 * server's question is not the parent's task), or plan mode (the session only reads).
 */
function nobodyToAsk(ctx: HostContext, env: NodeJS.ProcessEnv): boolean {
	if (!ctx.hasUI || envFlag(env, SUBAGENT_ENV)) return true;
	return ctx.sessionManager !== undefined && planConstraintActive(ctx.sessionManager);
}

const fieldId = (index: number): string => `f${index + 1}`;

/** The options of a field's question, by answer: a boolean's yes and no, an enum's values, and a way past an optional one. */
function optionsOf(field: McpElicitationField): NonNullable<Question["options"]> | undefined {
	const listed =
		field.type === "boolean"
			? [
					{ id: YES, label: "Yes" },
					{ id: NO, label: "No" },
				]
			: field.options?.map((option, index) => ({ id: String(index + 1), label: option.label }));
	return listed && !field.required ? [...listed, { id: SKIP, label: "Skip (leave empty)" }] : listed;
}

/**
 * One question per field, or one yes/no when the server asks for nothing but consent. The server's name leads, from the
 * session's own configuration; every word the server sent sits inside the fence below it, so it cannot pass for the
 * harness. The server's message opens the first question, and a rejected answer's reason closes it.
 */
function questionsOf(request: McpElicitationRequest): Question[] {
	const server = headerText(request.server, 60);
	const count = request.fields.length;
	const fenced = (index: number, lines: string[]): string =>
		fenceUntrusted(
			`MCP server "${server}" asks for input${count > 1 ? ` (${index + 1} of ${count})` : ""}`,
			[...(index === 0 && request.message ? [request.message, ""] : []), ...lines].join("\n").trimEnd(),
			{
				note: SERVER_TEXT_NOTE,
				...(index === 0 && request.problem
					? { footer: `The last answer was not sent: ${request.problem}. Answer again.` }
					: {}),
			},
		);
	if (count === 0)
		return [
			{
				id: fieldId(0),
				type: "choice",
				question: fenced(0, []),
				options: [
					{ id: ACCEPT, label: "Continue" },
					{ id: DECLINE, label: "Decline" },
				],
				writeIn: false,
			},
		];
	return request.fields.map((field, index): Question => {
		const kind = field.type === "number" ? " (a number)" : field.type === "integer" ? " (a whole number)" : "";
		const line = `${field.label}${kind}${field.required ? "" : " (optional)"}${field.description ? `: ${field.description}` : ""}`;
		const options = optionsOf(field);
		return options
			? { id: fieldId(index), type: "choice", question: fenced(index, [line]), options, writeIn: false }
			: { id: fieldId(index), type: "text", question: fenced(index, [line]) };
	});
}

/** The value a reply gives its field: the picked option's, else what was typed; undefined when it holds none. */
function valueOf(field: McpElicitationField, reply: Extract<Reply, { picks: string[] }>): string | boolean | undefined {
	const pick = reply.picks[0];
	if (pick === SKIP && !field.required) return undefined;
	if (field.type === "boolean" && (pick === YES || pick === NO)) return pick === YES;
	const option = pick === undefined ? undefined : field.options?.[Number(pick) - 1];
	return option?.value ?? (reply.text?.trim() || undefined);
}

/**
 * The replies as the server's answer. Nothing answered is no answer: `decline` where nobody could be asked, else `cancel`
 * (dismissed, interrupted, timed out). Otherwise each answered field is sent and one left open is left out; MCP checks the
 * result against the request, so a required field left open is asked again there.
 */
function answerOf(request: McpElicitationRequest, replies: readonly Reply[]): McpElicitationAnswer {
	const answered = replies.filter((reply) => "picks" in reply);
	if (answered.length === 0)
		return {
			action: replies.some((reply) => "cancelled" in reply && reply.cancelled === "unavailable") ? "decline" : "cancel",
		};
	if (request.fields.length === 0)
		return answered[0].picks[0] === ACCEPT ? { action: "accept", content: {} } : { action: "decline" };
	const content: Record<string, string | boolean> = {};
	request.fields.forEach((field, index) => {
		const reply = answered.find((candidate) => candidate.id === fieldId(index));
		const value = reply ? valueOf(field, reply) : undefined;
		if (value !== undefined) content[field.name] = value;
	});
	return { action: "accept", content };
}

/**
 * A server's request for input, asked the way `askUser` asks: the same dialogs, in the session of the tool call that
 * was waiting on the server. `env` is a seam for tests; the host reads the process environment.
 */
export function mcpElicitation(env: NodeJS.ProcessEnv = process.env): McpElicitationPort {
	return {
		async ask(request) {
			// The context is the one this host gave the tool call; MCP's own type names only what MCP reads.
			const ctx = request.ctx as unknown as HostContext;
			if (nobodyToAsk(ctx, env)) return { action: "decline" };
			const questions = questionsOf(request);
			return answerOf(request, await ask(ctx, questions, { signal: request.signal }));
		},
	};
}

export const elicitation: McpElicitationPort = mcpElicitation();
