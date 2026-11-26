import {
	type AssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type Message,
	type ToolResultMessage,
} from "@octocodeai/octocode-ai";
import type { AcpImage } from "../../../../acp/src/client/session-config.ts";
import type { CallToolResult, ServedTool } from "../../../../mcp/src/api.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { sectionFamilyText } from "../../core/system-prompt-spec.ts";

/** Tool call ids this backend gives the calls an agent makes, so their results are known as already answered. */
export const CALL_PREFIX = "ccode_";

/** A turn `provider` answered in the ACP session `acpSession`: the agent has seen everything up to it. */
const ownTurn = (message: Message, acpSession: string | undefined, provider: string): message is AssistantMessage =>
	message.role === "assistant" &&
	message.provider === provider &&
	acpSession !== undefined &&
	message.responseId === acpSession;

/** The ACP session of the last turn `provider` answered, which a later process resumes. */
export function lastSession(messages: readonly Message[], provider: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant" && message.provider === provider && message.responseId) return message.responseId;
	}
	return undefined;
}

/**
 * Messages the agent of `provider` has not seen: after its last turn in `acpSession`, without the results it already
 * received over MCP; every message when that session has no turn here (a new session sees the whole conversation).
 */
export function unseen(messages: readonly Message[], acpSession: string | undefined, provider: string): Message[] {
	let anchor = -1;
	for (let index = messages.length - 1; index >= 0 && anchor < 0; index--)
		if (ownTurn(messages[index], acpSession, provider)) anchor = index;
	const answered = (message: Message) =>
		anchor >= 0 && message.role === "toolResult" && message.toolCallId.startsWith(CALL_PREFIX);
	return messages.slice(anchor + 1).filter((message) => message.role !== "system" && !answered(message));
}

/** A user message as text; its images are named, or left out when they travel as image blocks (`withImages`). */
const userText = (message: Extract<Message, { role: "user" }>, withImages = false): string =>
	typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : withImages ? [] : [`[image ${block.mimeType}]`]))
				.join("\n");

/** Where the user's new messages begin: the run of user messages that ends `messages`. */
function requestStart(messages: readonly Message[]): number {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role === "user") start--;
	return start;
}

/** The images of the user's new messages, for an agent that takes them as image blocks. */
export function promptImages(messages: readonly Message[]): AcpImage[] {
	return messages
		.slice(requestStart(messages))
		.flatMap((message) =>
			message.role === "user" && typeof message.content !== "string"
				? message.content.flatMap((block) =>
						block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
					)
				: [],
		);
}

const resultText = (message: ToolResultMessage): string =>
	message.content.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`)).join("\n");

/** One message as transcript text, for a model that did not see it. Nothing is cut. */
function line(message: Message): string {
	switch (message.role) {
		case "user":
			return `[user]\n${userText(message)}`;
		case "assistant":
			return message.content
				.flatMap((block) =>
					block.type === "text"
						? [`[assistant]\n${block.text}`]
						: block.type === "toolCall"
							? [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`]
							: [],
				)
				.join("\n");
		case "toolResult":
			return `[tool result ${message.toolName}${message.isError ? ", error" : ""}]\n${resultText(message)}`;
		default:
			return "";
	}
}

/**
 * The prompt that brings the agent up to date: the user's new messages as they are, and, when the messages before
 * them were answered elsewhere (another model, or a session Claude Code no longer has), those turns as history first.
 */
export function promptText(messages: readonly Message[], withImages = false): string {
	const start = requestStart(messages);
	const request = messages
		.slice(start)
		.map((message) => userText(message as Extract<Message, { role: "user" }>, withImages))
		.join("\n\n");
	const history = messages.slice(0, start).map(line).filter(Boolean).join("\n\n");
	return history ? renderPrompt("system/claude-code-history.md", { history, request }) : request;
}

/** Octocode's instruction to the agent (`template`): one rule about its tools and the project's context files. */
export function appendedPrompt(messages: readonly Message[], template = "system/external-acp.md"): string {
	const projectContext = sectionFamilyText(getCurrentSystemMessage(messages)?.sections ?? {}, "project_context");
	return renderPrompt(template, { projectContext });
}

/** The session's declared tools as MCP tools: name, description and JSON Schema, nothing Octocode-internal. */
export function servedTools(messages: readonly Message[]): ServedTool[] {
	return getCurrentTools(messages).map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>,
	}));
}

/** A tool result Octocode's loop produced, as the MCP answer to the call Claude Code made. */
export function callResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map((block) =>
			block.type === "text"
				? { type: "text", text: block.text }
				: { type: "image", data: block.data, mimeType: block.mimeType },
		),
		...(message.isError ? { isError: true } : {}),
	};
}
