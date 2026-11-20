import fs from "node:fs";
import { type MessageRef, plainText, toolCallArguments } from "../files/reads.ts";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { shortPath } from "../../utils/display-path.ts";
import { saveContentCopy } from "../shared/spill.ts";
import { clearableBash } from "./clearable-bash.ts";
import { fileInputText, PLACEHOLDER_START } from "./clearing-view.ts";

/** What clearing may replace (`clearing.ts` decides when): old results of tools that can be fetched again, and the payloads of old `file` changes. */

/** The newest clearable results always kept (and as many `file` changes): the next step usually builds on the last few calls, and older ones come back by repeating the call or reading the saved file. */
export const KEEP_RECENT_RESULTS = 5;

/** A `file` call's payload (written content, edit texts, a patch) is cleared only from this many characters: a shorter one is not worth its placeholder. */
const FILE_INPUT_MIN_CHARS = 1_000;

/**
 * `web` and every MCP tool result (`isMcpToolName`): its whole text is saved to a file before it is cleared, and the
 * placeholder names that file. Never `agent`; a `file` result neither, but its call's payload, which is on disk once it
 * applied (`fileInputs`); `bash` only for a command that only prints (`clearableBash`), saved the same way unless Octocode
 * already spilled its whole output to a file.
 * `read`, `grep`, `find` and `ls` are not Octocode tools; they stay for resumed transcripts of other hosts that
 * hold their results, and for custom tools that still use those names.
 */
const CLEARABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "web"]);

export interface Candidate {
	id: string;
	tool: string;
	/** A tool result's text, or (`input`) the payload of a `file` call, which the assistant message holds. */
	kind: "result" | "input";
	text: string;
	/** The message's position in the context's messages: the result, or for an input the assistant message. */
	index: number;
	/** A `bash` result's spill file, when Octocode saved its whole output; otherwise the text is saved when cleared. */
	spilled?: string;
}

/** The repeated-read note behind a result (`details.unchangedOf`: the call it points at), if it is one. */
function noteOf(message: Record<string, unknown>): string | undefined {
	const unchangedOf = isRecord(message.details) ? message.details.unchangedOf : undefined;
	return typeof unchangedOf === "string" ? unchangedOf : undefined;
}

/** Commands already judged by `clearableBash`, which parses the shell line: every request asks again for the same calls. */
const readOnlyJudged = new Map<string, boolean>();
const JUDGED_LIMIT = 4_096;

/** Whether a `bash` call may be cleared: its command only prints (`clearableBash`), so repeating it is harmless. */
function readOnlyBash(args: Record<string, unknown> | undefined): boolean {
	const command = args?.command;
	if (typeof command !== "string") return false;
	const shell = args?.type === "powershell" ? "powershell" : "bash";
	const key = `${shell}\0${command}`;
	let judged = readOnlyJudged.get(key);
	if (judged === undefined) {
		if (readOnlyJudged.size >= JUDGED_LIMIT) readOnlyJudged.clear();
		judged = clearableBash(command, shell);
		readOnlyJudged.set(key, judged);
	}
	return judged;
}

/** Successful results of clearable tools that show only text and are not placeholders or repeated-read notes, oldest first. */
export function clearableResults(messages: readonly MessageRef[]): Candidate[] {
	const calls = toolCallArguments(messages);
	return messages.flatMap(({ message }, index): Candidate[] => {
		if (
			!isRecord(message) ||
			message.role !== "toolResult" ||
			message.isError === true ||
			typeof message.toolCallId !== "string" ||
			noteOf(message) !== undefined
		)
			return [];
		const tool = String(message.toolName);
		const bash = tool === "bash" && readOnlyBash(calls.get(message.toolCallId));
		const text = CLEARABLE_TOOLS.has(tool) || isMcpToolName(tool) || bash ? plainText(message.content) : undefined;
		if (text === undefined || text.startsWith(PLACEHOLDER_START)) return [];
		const spilled = bash && isRecord(message.details) ? message.details.fullOutputPath : undefined;
		return [
			{
				id: message.toolCallId,
				tool,
				kind: "result",
				text,
				index,
				...(typeof spilled === "string" ? { spilled } : {}),
			},
		];
	});
}

/**
 * The `file` calls whose change applied (a result that is not an error) and whose payload holds at least
 * `FILE_INPUT_MIN_CHARS`, oldest first: the change is on disk, so the text the call carried can leave the context.
 */
export function fileInputs(messages: readonly MessageRef[]): Candidate[] {
	const applied = new Set<string>();
	for (const { message } of messages)
		if (
			isRecord(message) &&
			message.role === "toolResult" &&
			message.toolName === "file" &&
			message.isError !== true &&
			typeof message.toolCallId === "string"
		)
			applied.add(message.toolCallId);
	return messages.flatMap(({ message }, index): Candidate[] => {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
		return message.content.flatMap((part): Candidate[] => {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "file" || typeof part.id !== "string") return [];
			if (!applied.has(part.id)) return [];
			const text = fileInputText(part.arguments);
			return text.length >= FILE_INPUT_MIN_CHARS ? [{ id: part.id, tool: "file", kind: "input", text, index }] : [];
		});
	});
}

/** All but the newest `KEEP_RECENT_RESULTS` of each kind not yet cleared (`cleared`: results; `inputs`: file calls). */
export function olderCandidates(
	candidates: readonly Candidate[],
	cleared: ReadonlyMap<string, string>,
	inputs: ReadonlySet<string>,
): Candidate[] {
	const older = (kind: Candidate["kind"], done: (id: string) => boolean) => {
		const open = candidates.filter((candidate) => candidate.kind === kind && !done(candidate.id));
		return open.slice(0, Math.max(open.length - KEEP_RECENT_RESULTS, 0));
	};
	return [...older("result", (id) => cleared.has(id)), ...older("input", (id) => inputs.has(id))].sort(
		(a, b) => a.index - b.index,
	);
}

/** Where a result's whole text is: Octocode's spill file of a `bash` command when it still exists, else a copy saved now. */
export function savedCopy(candidate: Candidate, outputDir: () => string): string | undefined {
	if (candidate.spilled !== undefined && fs.existsSync(candidate.spilled)) return shortPath(candidate.spilled);
	return saveContentCopy(candidate.text, `cleared-${candidate.tool}`, "txt", outputDir);
}
