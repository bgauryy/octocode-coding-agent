import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { deniedRow, endedWithout, failTurn, isSessionId, num, str, targetOf, toolRow, totals } from "./common.ts";
import type { HeadlessParser, HeadlessReply, HeadlessRoute, ParserInput } from "./types.ts";

const SIGNED_OUT = /not logged in|log ?in required|please (run )?codex login|unauthorized|\b401\b|invalid api key/i;

/**
 * `codex exec --json`: `thread.started`, `turn.started`, `item.started|updated|completed`, `turn.completed` (with
 * `usage`) or `turn.failed`, and `error`. Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `web_search`, `todo_list`, `error`. Source: https://developers.openai.com/codex/noninteractive
 * ("Make output machine-readable") and the event types in openai/codex `codex-rs/exec/src/exec_events.rs`.
 */
class CodexParser implements HeadlessParser {
	private lastText = "";
	private completed: Record<string, unknown> | undefined;
	private failure: string | undefined;
	private threadId: string | undefined;
	private readonly input: ParserInput;
	constructor(input: ParserInput) {
		this.input = input;
	}

	get done(): boolean {
		return this.completed !== undefined || this.failure !== undefined;
	}

	line(event: Record<string, unknown>): void {
		if (event.type === "thread.started") this.threadId = isSessionId(event.thread_id) ? event.thread_id : undefined;
		else if (event.type === "turn.completed") this.completed = event;
		else if (event.type === "turn.failed")
			this.failure = (isRecord(event.error) ? str(event.error.message) : undefined) ?? "turn failed";
		else if (event.type === "error") this.failure ??= str(event.message);
		else if ((event.type === "item.started" || event.type === "item.completed") && isRecord(event.item))
			this.item(event.type, event.item);
	}

	private item(phase: string, item: Record<string, unknown>): void {
		const started = phase === "item.started";
		if (item.type === "agent_message" && !started) this.lastText = str(item.text) ?? this.lastText;
		else if (item.type === "command_execution") {
			if (started) this.input.onActivity(toolRow("Bash", targetOf({ command: item.command }, this.input.roots)));
			else if (item.status === "declined")
				this.input.onActivity(deniedRow(`declined ${str(item.command) ?? "command"}`));
		} else if (item.type === "file_change" && !started) {
			const changes = Array.isArray(item.changes) ? item.changes : [];
			for (const change of changes)
				if (isRecord(change))
					this.input.onActivity(
						toolRow(`Edit ${str(change.kind) ?? ""}`.trim(), targetOf({ path: change.path }, this.input.roots)),
					);
		} else if (item.type === "mcp_tool_call" && started)
			this.input.onActivity(toolRow(`mcp ${str(item.server) ?? ""} ${str(item.tool) ?? ""}`.trim(), ""));
		else if (item.type === "web_search" && started) this.input.onActivity(toolRow("WebSearch", str(item.query) ?? ""));
	}

	reply(code: number | null, stderr: string): HeadlessReply {
		if (this.failure !== undefined && !this.completed) failTurn(this.input.runner, this.failure, SIGNED_OUT);
		const completed = this.completed;
		if (!completed) endedWithout(this.input.runner, code, stderr, SIGNED_OUT);
		const usage = isRecord(completed.usage) ? completed.usage : undefined;
		const input = num(usage?.input_tokens);
		const output = num(usage?.output_tokens);
		const cached = num(usage?.cached_input_tokens) ?? 0;
		const written = num(usage?.cache_write_input_tokens) ?? 0;
		// Codex counts cached tokens inside `input_tokens`; ACP turns report them apart.
		const totalsOf =
			input !== undefined && output !== undefined
				? totals(Math.max(0, input - cached - written), output, cached, written)
				: undefined;
		return {
			text: this.lastText,
			stopReason: "end_turn",
			...(totalsOf ? { usage: totalsOf } : {}),
			...(this.threadId ? { sessionId: this.threadId } : {}),
			billing: this.input.billing,
		};
	}
}

/**
 * `codex exec` runs one task and exits. With no prompt argument it reads the task from stdin, so it never reaches argv.
 * `--ignore-user-config` skips the user's `config.toml` (its MCP servers, profiles and approval settings; the sign-in
 * stays in `CODEX_HOME`). The session is kept on disk (no `--ephemeral`): a later turn resumes it by the `thread_id` of
 * `thread.started`. Permissions are the sandbox: in its own worktree a
 * task gets `workspace-write` (writes limited to that folder, no network); in the session's folder, or for a read-only caller, `read-only`.
 * `codex exec` asks nothing, so a command the sandbox refuses fails instead of running. Never `danger-full-access`,
 * `--dangerously-bypass-approvals-and-sandbox`, or `--approve-for-me`.
 * Flags: `codex exec --help` of 0.166.0 (2026-11-21).
 */
export const codexRoute: HeadlessRoute = {
	id: "codex",
	label: "headless (adapter missing)",
	tested: "0.166.0",
	enabled: true,
	args: ["exec", "--json", "--color", "never", "--ignore-user-config"],
	env: {},
	task: "text",
	communication: false,
	permission: ({ isolated, readOnly }) => ({
		args: ["--sandbox", isolated && readOnly !== true ? "workspace-write" : "read-only"],
	}),
	model: (model) => ["--model", model],
	// `codex exec resume [SESSION_ID] [PROMPT]` (`-` reads the prompt from stdin) of `codex exec resume --help` 0.166.0 and
	// https://developers.openai.com/codex/noninteractive#resume-a-session. The subcommand takes no `--sandbox`: the
	// options before it (permission, model) apply, so `resume` ends the argv.
	resume: (sessionId) => ({ args: [], trailing: ["resume", sessionId, "-"] }),
	parser: (input) => new CodexParser(input),
};
