// Antigravity conversation steps: the brain transcript (user prompts, planner tool calls, final text) and the
// error the step database ends on (a quota stop, a 429, an abort), which explains why a run stopped.
import { join } from "node:path";
import { clip, exists, jsonLines, readText, sqlite } from "./common.mjs";

/** Step type the step database uses for an error message. */
const ERROR_STEP = 17;

const unquote = (value) => {
	if (typeof value !== "string") return JSON.stringify(value);
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "string" ? parsed : value;
	} catch {
		return value;
	}
};

/** The first argument of a planner tool call as one line: the path, command or query it acted on. */
function callArg(args) {
	const [first] = Object.values(args ?? {});
	return first === undefined ? "" : clip(unquote(first).replace(/\s+/g, " "), 200);
}

/** The prompt inside `<USER_REQUEST>`; Antigravity appends metadata blocks after it. */
function promptText(content) {
	const text = String(content ?? "");
	const inner = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
	return (inner ? inner[1] : text).trim();
}

/**
 * Events from `brain/<id>/.system_generated/logs/transcript.jsonl`: `USER_INPUT` is a prompt, a model step's
 * `tool_calls` are tools, a model step's text is the assistant's. Tool results and system messages are left out.
 * Undefined when the conversation has no transcript.
 */
export function transcriptEvents(agyHome, id) {
	const file = join(agyHome, "brain", id, ".system_generated", "logs", "transcript.jsonl");
	if (!exists(file)) return undefined;
	const events = [];
	for (const step of jsonLines(readText(file))) {
		if (step.type === "USER_INPUT") {
			const text = promptText(step.content);
			if (text) events.push({ kind: "user", text });
		} else if (step.type === "PLANNER_RESPONSE") {
			if (typeof step.content === "string" && step.content.trim())
				events.push({ kind: "assistant", text: step.content });
			for (const call of step.tool_calls ?? []) {
				events.push({ kind: "tool", name: call.name, arg: callArg(call.args) });
			}
		}
	}
	return events;
}

/** Patterns for the line of an error payload that says what happened, most telling first. */
const CAUSE = [/\(code \d+\)|HTTP \d{3}/, /RESOURCE_EXHAUSTED|QUOTA|ABORTED|CANCEL/i, /error|quota|limit|fail/i];

/** The readable line of a protobuf error payload: printable runs, the one that names the cause. */
function causeLine(blob) {
	const runs =
		Buffer.from(blob, "hex")
			.toString("utf8")
			.match(/[\x20-\x7e\u00a0-\uffff]{12,}/g) ?? [];
	for (const pattern of CAUSE) {
		const run = runs.find((candidate) => pattern.test(candidate));
		if (run) return run.trim();
	}
	return undefined;
}

/**
 * The error line when the step database's last step is an error, so the run ended on it; undefined when the run
 * ended normally or sqlite3 is missing.
 */
export function lastError(db) {
	if (!exists(db)) return undefined;
	const [last] =
		sqlite(db, "select idx, step_type, length(error_details) as n from steps order by idx desc limit 1") ?? [];
	if (!last || (last.step_type !== ERROR_STEP && !last.n)) return undefined;
	const [row] =
		sqlite(db, `select hex(error_details) as e, hex(step_payload) as p from steps where idx = ${Number(last.idx)}`) ??
		[];
	const line = causeLine(row?.e ?? "") ?? causeLine(row?.p ?? "");
	return line ? { step: last.idx, text: line } : undefined;
}
