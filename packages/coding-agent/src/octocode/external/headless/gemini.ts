import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { deniedRow, endedWithout, failTurn, num, str, targetOf, toolRow, totals } from "./common.ts";
import type { HeadlessParser, HeadlessReply, HeadlessRoute, ParserInput } from "./types.ts";

const SIGNED_OUT = /auth method|GEMINI_API_KEY|not logged in|log ?in required|unauthenticated|api key not valid/i;

/**
 * `gemini -p --output-format stream-json`: newline-delimited `init`, `message` (`role`, `content`, `delta`),
 * `tool_use` (`tool_name`, `parameters`), `tool_result` (`status`, `error`), `error` (`severity`, `message`) and a
 * final `result` (`status`, `error`, `stats`). Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
 * and `packages/core/src/output/types.ts`.
 */
class GeminiParser implements HeadlessParser {
	/** Assistant text since the last tool call: the answer is what the model said after its last action. */
	private text = "";
	private all = "";
	private result: Record<string, unknown> | undefined;
	private readonly names = new Map<string, string>();
	private readonly input: ParserInput;
	constructor(input: ParserInput) {
		this.input = input;
	}

	get done(): boolean {
		return this.result !== undefined;
	}

	line(event: Record<string, unknown>): void {
		if (event.type === "result") this.result = event;
		else if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
			this.text += event.content;
			this.all += event.content;
		} else if (event.type === "tool_use") {
			this.text = "";
			const name = str(event.tool_name) ?? "tool";
			if (typeof event.tool_id === "string") this.names.set(event.tool_id, name);
			this.input.onActivity(toolRow(name, targetOf(event.parameters, this.input.roots)));
		} else if (event.type === "tool_result" && event.status === "error") {
			const name = this.names.get(String(event.tool_id)) ?? "tool";
			const why = isRecord(event.error) ? str(event.error.message) : undefined;
			this.input.onActivity(deniedRow(`${name} failed${why ? `: ${why}` : ""}`));
		}
	}

	reply(code: number | null, stderr: string): HeadlessReply {
		const result = this.result;
		if (!result) endedWithout(this.input.runner, code, stderr, SIGNED_OUT);
		const text = this.text.trim() || this.all.trim();
		if (result.status !== "success") {
			const error = isRecord(result.error) ? str(result.error.message) : undefined;
			failTurn(this.input.runner, [error, stderr.trim()].filter(Boolean).join("\n") || "error", SIGNED_OUT);
		}
		const stats = isRecord(result.stats) ? result.stats : undefined;
		const input = num(stats?.input);
		const output = num(stats?.output_tokens);
		// `input` is `input_tokens` without the cached part, which `cached` reports.
		const usage =
			input !== undefined && output !== undefined ? totals(input, output, num(stats?.cached) ?? 0) : undefined;
		return { text, stopReason: "end_turn", ...(usage ? { usage } : {}), billing: this.input.billing };
	}
}

/**
 * `-p` runs headless: a fixed instruction is the prompt and the task text on stdin is prepended to it ("Appended to
 * input on stdin"), so the task never reaches argv. Permissions are the approval mode: headless, anything that would
 * ask is denied (the policy engine turns ASK_USER into DENY), so `default` (the session's folder) allows no edits or
 * commands, and `auto_edit` (its own worktree) accepts edits only. Never `yolo`, `--yolo` or `--skip-trust`.
 * Flags: `gemini --help` of 0.64.0 (2026-11-21).
 */
export const geminiRoute: HeadlessRoute = {
	id: "gemini",
	label: "headless (adapter missing)",
	tested: "0.64.0",
	enabled: true,
	args: ["--output-format", "stream-json", "-p", "Do the task given above."],
	env: {},
	task: "text",
	communication: false,
	permission: ({ isolated, readOnly }) => ({
		args: ["--approval-mode", isolated && readOnly !== true ? "auto_edit" : "default"],
	}),
	model: (model) => ["--model", model],
	// `--resume` of `gemini --help` 0.64.0 takes "latest" or an index into the project's session list, not a session id,
	// so no session of this task's own can be named (https://google-gemini.github.io/gemini-cli/docs/cli/session-management.html).
	resume: () => ({
		refuse:
			"Gemini CLI resumes a session by its position in the project's list (--resume latest or an index), not by an id, so it cannot continue this task's own session.",
	}),
	parser: (input) => new GeminiParser(input),
};
