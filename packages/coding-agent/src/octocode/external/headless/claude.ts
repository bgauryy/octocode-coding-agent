import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import type { ExternalUsage } from "@octocodeai/octocode-contracts/external";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { clip } from "../../shared/text.ts";
import { CLAUDE_ISOLATION_ARGS } from "../runner-isolation.ts";
import { endedWithout, failTurn, isSessionId, num, targetOf, toolRow, totals } from "./common.ts";
import type { HeadlessParser, HeadlessReply, HeadlessRoute, ParserInput } from "./types.ts";

const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i;
/** Claude Code's result subtypes as ACP stop reasons (`runner-child.ts` reads those). */
const RESULT_STOPS: Record<string, string> = {
	error_max_turns: "max_turn_requests",
	error_max_budget_usd: "max_tokens",
};
const API_STOPS = new Set(["end_turn", "max_tokens", "refusal"]);

/**
 * The fixed part of the command: `-p` prints and exits (no prompt argument: the task comes on stdin, so its length and
 * any secret in it never reach argv), and `--output-format stream-json` streams one JSON event per line, which needs
 * `--verbose` with `-p`. Streaming input delivers the task without ending the process's input channel. The isolation
 * arguments keep the user's sign-in and drop their settings, MCP servers and slash commands.
 *
 * Not `--bare`: bare mode never reads OAuth or the keychain (docs: code.claude.com/docs/en/headless#start-faster-with-bare-mode),
 * so a subscription login would fail, and the docs say it will become the default for `-p`. The route states
 * the mode itself with `CLAUDE_CODE_SIMPLE=0` (`env` below).
 */
export const HEADLESS_ARGS: readonly string[] = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	...CLAUDE_ISOLATION_ARGS,
];

/** Claude Code's `usage` (Anthropic field names) as the totals an ACP turn reports. */
function usageOf(value: unknown): ExternalUsage | undefined {
	if (!isRecord(value)) return undefined;
	const inputTokens = num(value.input_tokens);
	const outputTokens = num(value.output_tokens);
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	return totals(inputTokens, outputTokens, num(value.cache_read_input_tokens), num(value.cache_creation_input_tokens));
}

/** The text blocks of an assistant event: the answer when the result event carries none. */
const textOf = (content: unknown[]): string =>
	content
		.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => (block as { text: string }).text)
		.join("");

/** Claude Code's stream: tool calls go to the row, the last assistant text and the result event are kept. */
class ClaudeParser implements HeadlessParser {
	private lastText = "";
	private result: Record<string, unknown> | undefined;
	private readonly input: ParserInput;
	constructor(input: ParserInput) {
		this.input = input;
	}

	get done(): boolean {
		return this.result !== undefined;
	}

	line(event: Record<string, unknown>): void {
		if (event.type === "result") {
			this.result = event;
			const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
			for (const denial of denials)
				if (isRecord(denial) && typeof denial.tool_name === "string")
					this.input.onActivity(`✗ denied ${clip(redactSecrets(denial.tool_name), 60)}`);
			return;
		}
		if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return;
		const content = event.message.content;
		const text = textOf(content);
		if (text) this.lastText = text;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "tool_use") continue;
			const name = typeof block.name === "string" && block.name ? block.name : "tool";
			this.input.onActivity(toolRow(name, targetOf(block.input, this.input.roots)));
		}
	}

	reply(code: number | null, stderr: string): HeadlessReply {
		const result = this.result;
		if (!result) endedWithout(this.input.runner, code, stderr, SIGNED_OUT);
		const text = typeof result.result === "string" && result.result ? result.result : this.lastText;
		const subtype = typeof result.subtype === "string" ? result.subtype : "";
		const stop =
			RESULT_STOPS[subtype] ??
			(typeof result.stop_reason === "string" && API_STOPS.has(result.stop_reason) ? result.stop_reason : "end_turn");
		const failed = result.is_error === true || (subtype !== "success" && !(subtype in RESULT_STOPS));
		if (failed) {
			const errors = Array.isArray(result.errors) ? result.errors.filter((each) => typeof each === "string") : [];
			failTurn(this.input.runner, [text, ...errors, stderr.trim()].filter(Boolean).join("\n") || subtype, SIGNED_OUT);
		}
		const usage = usageOf(result.usage);
		const cost = num(result.total_cost_usd);
		const sessionId = isSessionId(result.session_id) ? result.session_id : undefined;
		return {
			text,
			stopReason: stop,
			...(usage ? { usage } : {}),
			...(cost !== undefined ? { cost } : {}),
			...(sessionId ? { sessionId } : {}),
			billing: this.input.billing,
		};
	}
}

/**
 * Permissions, since headless mode sends no ACP permission request Octocode could answer. `--permission-prompts none`
 * denies whatever would prompt; the mode decides the rest. In its own worktree a task gets `acceptEdits`: Claude Code
 * accepts file edits inside its working directory only, so edits outside it, and every command or fetch its user's
 * own allow rules do not cover, are denied. A task in the session's own folder gets `manual`: nothing is accepted
 * that would ask, so it cannot change the user's checkout. Never `bypassPermissions` or `--dangerously-skip-permissions`.
 */
export const claudeRoute: HeadlessRoute = {
	id: "claude-code",
	label: "headless (adapter missing)",
	// Flags checked in `claude --help` of 2.1.330 (2026-11-21); the stream shape is the one the SDK documents.
	tested: "2.1.330",
	enabled: true,
	args: HEADLESS_ARGS,
	env: { CLAUDE_CODE_SIMPLE: "0" },
	task: "json",
	communication: true,
	permission: ({ isolated, readOnly }) => ({
		args: [
			"--permission-mode",
			isolated && readOnly !== true ? "acceptEdits" : "manual",
			"--permission-prompts",
			"none",
		],
	}),
	model: (model) => ["--model", model],
	// `-r, --resume <session-id>` of `claude --help` 2.1.330; https://code.claude.com/docs/en/headless#continue-conversations
	// (the result event's `session_id` is what a later `--resume` takes). The route never passes `--no-session-persistence`.
	resume: (sessionId) => ({ args: ["--resume", sessionId] }),
	parser: (input) => new ClaudeParser(input),
};
