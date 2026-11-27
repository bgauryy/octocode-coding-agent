import type { SessionEntry } from "../../../core/session-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { SHELL_TOOLS } from "../../permission/shell.ts";
import { clipText, contentText } from "../../shared/util.ts";

/**
 * The outside signals a session produced, read from its entries in code: reflection runs only on one (`reflect.ts`),
 * since a lesson drawn without outside feedback is as likely wrong as right. Each signal points at the entries that show
 * it, so a reflection can cite its evidence.
 */

type SignalKind = "correction" | "recovered" | "refused" | "reverted" | "repeated";

export interface SessionSignal {
	kind: SignalKind;
	/** The entries that show it, oldest first. */
	entries: string[];
	/** What happened, in a line: the user's words, the command, the error. */
	evidence: string;
}

interface SessionReview {
	userTurns: number;
	signals: SessionSignal[];
}

/** Signals handed to a reflection; the newest are kept. */
const MAX_SIGNALS = 8;
const EVIDENCE_CHARS = 240;

/** A user message that corrects the agent: it opens by saying no, stop or instead, or says the agent got it wrong. */
const CORRECTION_START =
	/^\W*(?:no\b|nope\b|wrong\b|incorrect\b|stop\b|don'?t\b|do not\b|never\b|actually\b|instead\b|not (?:that|what|like that|quite)\b|that(?:'s| is| was) (?:not|wrong|incorrect)\b|i (?:said|told you|asked|meant)\b|why (?:did|do|are) you\b|you (?:should(?:n'?t)?|didn'?t|forgot|missed|broke|ignored)\b|please (?:don'?t|do not|stop)\b|revert\b|undo\b)/i;
const CORRECTION_ANYWHERE =
	/\b(?:that's not what i (?:asked|meant|said|wanted)|i told you|as i said|you ignored|you were supposed to)\b/i;
/** A refused call's result: a user's denial, a dismissed dialog, or no one to ask (`permission/ask/text.ts`). */
const REFUSED = /^(?:The user denied\b|Not run[:,])/;
/** A shell command that runs a check: tests, a typecheck, a linter, a build. */
const CHECK =
	/\b(?:test|tests|vitest|jest|mocha|pytest|tox|cargo (?:test|check|clippy|build)|go (?:test|vet|build)|tsc|typecheck|lint|oxlint|eslint|biome|ruff|mypy|check|build|make)\b/;
/** A shell command that undoes changes. */
const REVERT = /\bgit\s+(?:revert|restore|reset\s+--hard|checkout\s+--)\b/;
/** The custom message `/rewind` sends after restoring files (`files/checkpoint-command.ts`). */
const REWIND_TYPE = "octocode-rewind";

interface Call {
	name: string;
	input: Record<string, unknown>;
}

const commandOf = (call: Call | undefined): string | undefined =>
	call && SHELL_TOOLS.has(call.name) && typeof call.input.command === "string" ? call.input.command : undefined;

/** A check command as compared between runs: output pipes and redirects dropped, spacing folded. */
const checkKey = (command: string): string =>
	command
		.replace(/\s*\|\s*(?:tail|head|grep|tee|cat|less)\b[^|]*$/g, "")
		.replace(/\s*\d?>&\d|\s*>\s*\S+/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** An error's first line with numbers and quoted parts folded, so the same failure on another file or line matches. */
const errorKey = (text: string): string =>
	(text.split("\n").find((line) => line.trim()) ?? "")
		.toLowerCase()
		.replace(/(["'`]).*?\1/g, "…")
		.replace(/\d+/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);

const failed = (message: { isError?: boolean; details?: unknown }): boolean =>
	message.isError === true ||
	(isRecord(message.details) && typeof message.details.exitCode === "number" && message.details.exitCode !== 0);

/** The user turns and outside signals of `entries` (a session's branch, oldest first). */
export function reviewSession(entries: readonly SessionEntry[]): SessionReview {
	const signals: SessionSignal[] = [];
	const calls = new Map<string, Call>();
	const failedChecks = new Map<string, string>();
	const errors = new Map<string, string>();
	const repeated = new Set<string>();
	let userTurns = 0;
	let answered = false;
	const add = (kind: SignalKind, ids: string[], evidence: string) =>
		signals.push({ kind, entries: ids, evidence: clipText(evidence.replace(/\s+/g, " ").trim(), EVIDENCE_CHARS) });
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			if (entry.customType === REWIND_TYPE) add("reverted", [entry.id], contentText(entry.content));
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			userTurns++;
			const text = contentText(message.content);
			if (answered && (CORRECTION_START.test(text) || CORRECTION_ANYWHERE.test(text)))
				add("correction", [entry.id], text);
			continue;
		}
		if (message.role === "assistant") {
			answered = true;
			for (const part of message.content)
				if (part.type === "toolCall") calls.set(part.id, { name: part.name, input: part.arguments });
			continue;
		}
		if (message.role !== "toolResult") continue;
		const text = contentText(message.content);
		const call = calls.get(message.toolCallId);
		if (REFUSED.test(text)) {
			add("refused", [entry.id], `${message.toolName}: ${text}`);
			continue;
		}
		const command = commandOf(call);
		if (command && CHECK.test(command)) {
			const key = checkKey(command);
			const earlier = failedChecks.get(key);
			if (failed(message)) failedChecks.set(key, earlier ?? entry.id);
			else if (earlier) {
				failedChecks.delete(key);
				add("recovered", [earlier, entry.id], `\`${command}\` failed, then passed`);
			}
		}
		if (command && REVERT.test(command) && !failed(message)) add("reverted", [entry.id], command);
		if (!failed(message)) continue;
		const key = errorKey(text);
		if (key.length < 12 || repeated.has(key)) continue;
		const first = errors.get(key);
		if (!first) errors.set(key, entry.id);
		else {
			repeated.add(key);
			add("repeated", [first, entry.id], `${message.toolName}: ${text}`);
		}
	}
	return { userTurns, signals: signals.slice(-MAX_SIGNALS) };
}
