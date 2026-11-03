/**
 * Node's read-only form, supplied by the reservation gate. While another agent holds a reservation, inline Node code runs
 * only under the permission model (`interpreter-confinement.ts`). A line whose every refusal is a `node` run lacking only
 * those flags (`NODE_FLAGS_FAULT`) is rewritten with them after each `node` instead of refused: Node then refuses writes
 * and child processes itself (ERR_ACCESS_DENIED). The rewrite is taken only when the `node` words in command position
 * match the faulty runs one to one, and only when the rewritten line passes `interpreterRefusals` from a fresh parse, so
 * a misplaced flag can only leave the line refused. Python, Perl and Ruby have no such form and stay refused.
 */
import type { ExtensionAPI } from "../../core/features/index.ts";
import type { ParsedShell } from "../shared/shell-commands.ts";
import {
	CONFINE_FLAGS,
	CONFINED_WRAPPERS,
	DURATION,
	NODE,
	NODE_FLAGS_FAULT,
	NODE_PROGRAM,
} from "./interpreter-confinement.ts";
import { type InterpreterRefusal, interpreterRefusals } from "./interpreter.ts";

/** Stands for a quoted, escaped or commented character, so offsets in the masked line are offsets in the command. */
const MASK = "\u0001";
/** Words after which the next word is still a command (`{ node …`, `then node …`, `timeout 5 node …`). */
const KEYWORDS = new Set(["{", "!", "do", "then", "else", "elif", "if", "while", "until"]);
const SEPARATOR = /^[;&|()\n]$/;

/** The command with every quoted string, escaped character and comment masked character for character. */
function masked(command: string): string {
	let out = "";
	let index = 0;
	while (index < command.length) {
		const char = command[index];
		let end: number;
		if (char === "\\") end = index + 2;
		else if (char === "'") end = command.indexOf("'", index + 1) + 1 || command.length;
		else if (char === '"') {
			end = index + 1;
			while (end < command.length && command[end] !== '"') end += command[end] === "\\" ? 2 : 1;
			end++;
		} else if (char === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1])))
			end = command.indexOf("\n", index) === -1 ? command.length : command.indexOf("\n", index);
		else {
			out += char;
			index++;
			continue;
		}
		end = Math.min(end, command.length);
		out += MASK.repeat(end - index);
		index = end;
	}
	return out;
}

/**
 * The offset just past each `node` word in command position: first in a command (after a separator or a keyword), or
 * after the plain wrappers the confined form allows. Text inside quotes or comments is never one; a heredoc body is read
 * as lines, so a `node` there is counted and the counts then differ.
 */
function nodeOffsets(command: string): number[] {
	const offsets: number[] = [];
	let first = true;
	for (const match of masked(command).matchAll(/[;&|()\n]|[^\s;&|()]+/g)) {
		const word = match[0];
		if (SEPARATOR.test(word)) first = true;
		else if (!first) continue;
		else if (NODE_PROGRAM.test(word)) {
			offsets.push(match.index + word.length);
			first = false;
		} else
			first = KEYWORDS.has(word) || CONFINED_WRAPPERS.has(word.slice(word.lastIndexOf("/") + 1)) || DURATION.test(word);
	}
	return offsets;
}

/** What the gate does with a line's inline code: run it rewritten, refuse it, or (undefined) nothing to do. */
export type NodeConfinement = { command: string } | { refusal: InterpreterRefusal };

/**
 * The gate's verdict on a bash line's inline code while a reservation is held. `parse` is the shell parse port (`null`: it failed;
 * undefined: none wired). A rewrite that a fresh check still refuses reports that check's refusal, which names what
 * else keeps the line from the read-only form.
 */
export async function confineNode(
	command: string,
	env: NodeJS.ProcessEnv,
	parse: (command: string) => Promise<ParsedShell | null | undefined>,
): Promise<NodeConfinement | undefined> {
	const refusals = interpreterRefusals(command, env, await parse(command));
	if (refusals.length === 0) return undefined;
	// The refusal to report names what adding the flags would not fix, when there is such a fault.
	const refused = { refusal: refusals.find((refusal) => refusal.cause !== NODE_FLAGS_FAULT) ?? refusals[0] };
	if (!refusals.every((refusal) => NODE.test(refusal.name) && refusal.cause === NODE_FLAGS_FAULT)) return refused;
	const offsets = nodeOffsets(command);
	if (offsets.length !== refusals.length) return refused;
	let rewritten = command;
	for (const offset of offsets.toReversed())
		rewritten = `${rewritten.slice(0, offset)} ${CONFINE_FLAGS}${rewritten.slice(offset)}`;
	const left = interpreterRefusals(rewritten, env, await parse(rewritten));
	return left.length === 0 ? { command: rewritten } : { refusal: left[0] };
}

const CONFINED_NOTE = `[Another agent holds a reservation, so node ran with \`${CONFINE_FLAGS}\` added: it may read files, and a file write or child process fails with ERR_ACCESS_DENIED. Use the file tool for edits.]`;

/** Adds the note to the result of each call the gate rewrote; returns how the gate marks one. */
export function registerConfinedNote(api: ExtensionAPI): (toolCallId: string | undefined) => void {
	const rewritten = new Set<string>();
	api.on("tool_result", async (event) => {
		if (!rewritten.delete(event.toolCallId)) return undefined;
		return {
			content: [...event.content, { type: "text", text: CONFINED_NOTE }],
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});
	// A call a later gate refuses never reaches `tool_result`; its result message ends it.
	api.on("message_end", async (event) => {
		if (event.message.role === "toolResult") rewritten.delete(event.message.toolCallId);
	});
	return (toolCallId) => {
		if (toolCallId) rewritten.add(toolCallId);
	};
}
