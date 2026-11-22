import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { endedWithout, failTurn, isSessionId, num, str, targetOf, toolRow } from "./common.ts";
import type { HeadlessParser, HeadlessReply, HeadlessRoute, ParserInput } from "./types.ts";

const SIGNED_OUT = /not authenticated|agent login|cursor_api_key|unauthorized|not logged in/i;

/** `readToolCall` becomes `read`; the generic `function` form carries its own `name`. */
function toolName(call: Record<string, unknown>): { name: string; args: unknown } {
	const key = Object.keys(call).find((each) => each.endsWith("ToolCall"));
	const body = key && isRecord(call[key]) ? call[key] : undefined;
	if (key && body) return { name: key.slice(0, -"ToolCall".length), args: body.args };
	const fn = isRecord(call.function) ? call.function : {};
	return { name: str(fn.name) ?? "tool", args: undefined };
}

/**
 * `--output-format stream-json`: NDJSON `system` (`init`), `user`, `assistant` (`message.content[].text`), `tool_call`
 * (`subtype` `started`|`completed`, `call_id`, `tool_call.<name>ToolCall.args`) and a terminal `result` (`subtype`,
 * `is_error`, `result`). Source: https://cursor.com/docs/cli/reference/output-format
 */
class CursorParser implements HeadlessParser {
	private result: Record<string, unknown> | undefined;
	private lastText = "";
	private sessionId: string | undefined;
	private readonly input: ParserInput;
	constructor(input: ParserInput) {
		this.input = input;
	}

	get done(): boolean {
		return this.result !== undefined;
	}

	line(event: Record<string, unknown>): void {
		if ((event.type === "system" || event.type === "result") && isSessionId(event.session_id))
			this.sessionId = event.session_id;
		if (event.type === "result") this.result = event;
		else if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
			const text = event.message.content
				.map((block) => (isRecord(block) && block.type === "text" ? (str(block.text) ?? "") : ""))
				.join("");
			if (text) this.lastText = text;
		} else if (event.type === "tool_call" && event.subtype === "started" && isRecord(event.tool_call)) {
			const { name, args } = toolName(event.tool_call);
			this.input.onActivity(toolRow(name, targetOf(args, this.input.roots)));
		}
	}

	reply(code: number | null, stderr: string): HeadlessReply {
		const result = this.result;
		if (!result) endedWithout(this.input.runner, code, stderr, SIGNED_OUT);
		const text = str(result.result) ?? this.lastText;
		if (result.is_error === true || (result.subtype !== undefined && result.subtype !== "success"))
			failTurn(this.input.runner, [text, stderr.trim()].filter(Boolean).join("\n") || "error", SIGNED_OUT);
		const cost = num(result.total_cost_usd);
		return {
			text,
			stopReason: "end_turn",
			...(cost !== undefined ? { cost } : {}),
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			billing: this.input.billing,
		};
	}
}

/**
 * Cursor's print mode "writes to files in your workspace even without `--force`" and follows the approval rules an
 * interactive session has, so Octocode's approval cannot gate it (https://cursor.com/docs/cli/headless, "File
 * modification in scripts"). A task that may write therefore runs only in its own
 * worktree, where the files it writes are the task's isolated copy, and one in the session's folder is refused before the
 * CLI starts; a read-only caller's task runs in `--mode ask`, Cursor's read-only mode, anywhere. Both keep the
 * sandbox on for commands and omit `--force`, `--yolo`, `--approve-mcps` and `--trust`. The task is the last argument
 * (after `--`): no stdin form is documented. Flags: https://cursor.com/docs/cli/reference/parameters.
 */
export const cursorRoute: HeadlessRoute = {
	id: "cursor",
	label: "headless",
	// The installer's version on 2026-11-21; the CLI was not installed here, so no `--help` was read.
	tested: "2026.11.19",
	enabled: true,
	args: ["-p", "--output-format", "stream-json", "--sandbox", "enabled"],
	env: {},
	task: "argv",
	communication: false,
	permission: ({ isolated, readOnly }) => {
		if (readOnly === true) return { args: ["--mode", "ask"] };
		if (!isolated)
			return {
				refuse:
					"Cursor's print mode writes files in its workspace whatever Octocode approves, so a task that may write runs only in its own worktree. Start it with isolate: true, or give it a read-only task.",
			};
		return { args: [] };
	},
	model: (model) => ["--model", model],
	// `--resume [chatId]` of https://cursor.com/docs/cli/reference/parameters; the chat id is the `session_id` of the
	// stream's `system` and `result` events (https://cursor.com/docs/cli/reference/output-format).
	resume: (sessionId) => ({ args: ["--resume", sessionId] }),
	parser: (input) => new CursorParser(input),
};
