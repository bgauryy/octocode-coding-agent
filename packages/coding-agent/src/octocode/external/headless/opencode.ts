import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { deniedRow, endedWithout, failTurn, num, str, targetOf, toolRow, totals } from "./common.ts";
import type { HeadlessParser, HeadlessReply, HeadlessRoute, ParserInput } from "./types.ts";

const SIGNED_OUT = /not logged in|log ?in required|unauthorized|no providers? (are )?(connected|configured)|api key/i;

/**
 * `opencode run --format json`: one object per line, `{ type, timestamp, sessionID, ... }` with `type` `step_start`,
 * `text` (`part.text`), `reasoning`, `tool_use` (`part.tool`, `part.state`), `step_finish` (`part.tokens`,
 * `part.cost`), `error` (`error.message`) and `retry`. Source: sst/opencode `packages/cli/src/run/noninteractive.ts`.
 */
class OpencodeParser implements HeadlessParser {
	private text = "";
	private all = "";
	private failure: string | undefined;
	private inputTokens = 0;
	private outputTokens = 0;
	private cachedRead = 0;
	private cachedWrite = 0;
	private cost = 0;
	private measured = false;
	private readonly input: ParserInput;
	constructor(input: ParserInput) {
		this.input = input;
	}

	/** The process ends itself when the run ends; there is no terminal event to wait for. */
	readonly done = false;

	line(event: Record<string, unknown>): void {
		const part = isRecord(event.part) ? event.part : {};
		if (event.type === "text" && typeof part.text === "string") {
			this.text += part.text;
			this.all += part.text;
		} else if (event.type === "tool_use") {
			this.text = "";
			const state = isRecord(part.state) ? part.state : {};
			const name = str(part.tool) ?? "tool";
			if (state.status === "error") this.input.onActivity(deniedRow(`${name}: ${str(state.error) ?? "failed"}`));
			else this.input.onActivity(toolRow(name, targetOf(state.input, this.input.roots)));
		} else if (event.type === "step_finish") this.finish(part);
		else if (event.type === "error")
			this.failure = (isRecord(event.error) ? str(event.error.message) : undefined) ?? "error";
	}

	private finish(part: Record<string, unknown>): void {
		this.cost += num(part.cost) ?? 0;
		const tokens = isRecord(part.tokens) ? part.tokens : undefined;
		if (!tokens) return;
		this.measured = true;
		this.inputTokens += num(tokens.input) ?? 0;
		this.outputTokens += num(tokens.output) ?? 0;
		const cache = isRecord(tokens.cache) ? tokens.cache : {};
		this.cachedRead += num(cache.read) ?? 0;
		this.cachedWrite += num(cache.write) ?? 0;
	}

	reply(code: number | null, stderr: string): HeadlessReply {
		if (this.failure !== undefined) failTurn(this.input.runner, this.failure, SIGNED_OUT);
		const text = this.text.trim() || this.all.trim();
		if (!text) endedWithout(this.input.runner, code, stderr, SIGNED_OUT);
		if (code) failTurn(this.input.runner, stderr || `exit code ${code}`, SIGNED_OUT);
		return {
			text,
			stopReason: "end_turn",
			...(this.measured
				? { usage: totals(this.inputTokens, this.outputTokens, this.cachedRead, this.cachedWrite) }
				: {}),
			...(this.cost ? { cost: this.cost } : {}),
			billing: this.input.billing,
		};
	}
}

/**
 * `opencode run --format json`, the task on stdin. Without `--auto` a permission request is rejected, but whether
 * OpenCode asks before it edits or runs a command depends on its configuration, which Octocode cannot set from the
 * command line (V2 documents `--auto`, not a permission map), so no task is allowed through this route: `enabled` stays
 * false and a request names why. Flags: `opencode run --help` of 2.0.32 (2026-11-21).
 */
export const opencodeRoute: HeadlessRoute = {
	id: "opencode",
	label: "headless (adapter missing)",
	tested: "2.0.32",
	enabled: false,
	args: ["run", "--format", "json", "--standalone"],
	env: {},
	task: "text",
	communication: false,
	permission: () => ({
		refuse:
			"OpenCode's own permission defaults decide whether it asks before editing or running commands, and Octocode cannot restrict them from the command line. Use its ACP route (`opencode acp`).",
	}),
	model: (model) => ["--model", model],
	resume: () => ({ refuse: "OpenCode has no headless route a task may run through, so none can be resumed." }),
	parser: (input) => new OpencodeParser(input),
};
