import {
	type AssistantMessage,
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../../src/core/compaction/utils.ts";
import { SHARED_SUMMARY_PROMPT } from "../../../src/octocode/compaction/shared-summary.ts";
import type { Recording, ReplayTurn } from "./recording.ts";

/**
 * The model of a replay: each request of the session gets the next recorded assistant message of the current run, and a
 * summary request gets the next recorded compaction summary (a fixed checkpoint when the recording has none left). Every
 * request is checked against the recording as it arrives and dropped; only fingerprints and counts are kept, because
 * keeping the requests of a long session would hold gigabytes.
 */

/** The checkpoint a summary request gets once the recording's own summaries are used up. */
export const REPLAY_CHECKPOINT =
	"## Goal\nContinue the recorded session.\n\n## TL;DR\nReplay checkpoint: the recording has no summary for this compaction.";

type Message = TranscriptContext["messages"][number];

/** What a provider receives of one message: role and content, without the in-memory timestamp. */
const messageView = (message: Message) => {
	const { timestamp: _timestamp, ...rest } = message;
	return JSON.stringify(rest);
};

/**
 * Every request re-sends the conversation, nearly all of it the same message objects (97% on the fixture), so each
 * message is serialized once and remembered by identity; serializing the whole request every time was a third of a
 * replay's CPU. Every `VERIFY_EVERY`th request serializes everything again and reports a message whose text changed
 * under the same object: a change made in place would otherwise hide from the prefix check.
 */
const VERIFY_EVERY = 25;

/** The system message without its `environment` section (the date, the one part allowed to move). */
function systemFingerprint(context: TranscriptContext): string {
	const system = getCurrentSystemMessage(context.messages);
	const { environment: _environment, ...sections } = system?.sections ?? {};
	return JSON.stringify({ content: system?.content, sections });
}

/** Which parts of the system message differ between two fingerprints. */
function changedSections(before: string, after: string): string {
	const a = JSON.parse(before) as { content: unknown; sections: Record<string, unknown> };
	const b = JSON.parse(after) as { content: unknown; sections: Record<string, unknown> };
	const names = new Set([...Object.keys(a.sections), ...Object.keys(b.sections)]);
	const changed = [...names].filter((name) => JSON.stringify(a.sections[name]) !== JSON.stringify(b.sections[name]));
	if (JSON.stringify(a.content) !== JSON.stringify(b.content)) changed.unshift("(text outside a section)");
	return `sections changed: ${changed.join(", ")}`;
}

const textOf = (message: Message | undefined): string => {
	const content = (message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content)
		? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("")
		: String(content ?? "");
};

const callIds = (message: AssistantMessage | undefined): string[] =>
	message?.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])) ?? [];

export interface ReplayObservations {
	requests: number;
	summaryRequests: number;
	/** Summary requests answered with a recorded summary rather than the fixed checkpoint. */
	recordedSummariesUsed: number;
	/** Distinct system prompts and tool arrays per compaction segment (index = compactions seen before the request). */
	systemsBySegment: Array<Set<string>>;
	toolArraysBySegment: Array<Set<string>>;
	/** Where the system message changed inside a compaction segment, and which sections. */
	systemChanges: string[];
	/** Where a request did not open with the previous one, with no compaction between them. */
	prefixBreaks: string[];
	/** Requests where a message already sent had changed in place (found by the periodic full serialization). */
	changedInPlace: string[];
	/** Requests beyond the recorded run, after a reply without tool calls: a turn the session started by itself. */
	unscripted: string[];
	/** Requests after the recorded run's last reply asked for tools: the original run was cut there by a steer or abort. */
	runTails: number;
	/** Prompts whose recorded run has no successful reply: answered with a placeholder. */
	unanswered: number;
	/** Requests whose context does not end where the recording does: the wrong prompt, or other tool results. */
	diverged: string[];
	peakContextChars: number;
	/** The size of the first request after each compaction. */
	contextAfterCompaction: number[];
	compactionsSeen: number;
	/** Clearing decisions (old tool results replaced by a placeholder), and the requests that followed one. */
	clearings: number;
	requestsAfterClearing: number;
}

export function replayModel(recording: Recording) {
	const seen: ReplayObservations = {
		requests: 0,
		summaryRequests: 0,
		recordedSummariesUsed: 0,
		systemsBySegment: [new Set()],
		toolArraysBySegment: [new Set()],
		systemChanges: [],
		prefixBreaks: [],
		changedInPlace: [],
		unscripted: [],
		runTails: 0,
		unanswered: 0,
		diverged: [],
		peakContextChars: 0,
		contextAfterCompaction: [],
		compactionsSeen: 0,
		clearings: 0,
		requestsAfterClearing: 0,
	};
	const summaries = [...recording.summaries];
	const views = new WeakMap<object, string>();
	const providerView = (messages: readonly Message[], where: string) => {
		const verify = seen.requests % VERIFY_EVERY === 0;
		return messages.map((message) => {
			const known = views.get(message);
			if (known !== undefined && !verify) return known;
			const view = messageView(message);
			if (known !== undefined && known !== view) seen.changedInPlace.push(`${where}: a ${message.role} message`);
			views.set(message, view);
			return view;
		});
	};
	let previous: string[] | undefined;
	let compacted = false;
	/** Old tool results were cleared since the last request: the session rewrote its own prefix, by design. */
	let cleared = false;
	let turn: ReplayTurn | undefined;
	let plan: AssistantMessage[] = [];
	let last: AssistantMessage | undefined;
	let firstOfTurn = true;

	/** Checks the request's tail against the recording: the turn's trigger first, then the results of the last reply. */
	const divergence = (context: TranscriptContext): string | undefined => {
		const messages = context.messages;
		let lastAssistant = -1;
		for (let index = messages.length - 1; index >= 0; index--)
			if (messages[index].role === "assistant") {
				lastAssistant = index;
				break;
			}
		const after = messages.slice(lastAssistant + 1);
		const results = after.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
		if (firstOfTurn) {
			if (results.length > 0) return `results ${results.join(",")} where the turn's trigger was expected`;
			if (turn?.trigger.kind !== "user" || turn.trigger.text.length === 0) return undefined;
			const wanted = turn.trigger.text;
			return after.some((message) => message.role === "user" && textOf(message).includes(wanted))
				? undefined
				: "the turn's prompt is not after the last reply";
		}
		const expected = callIds(last);
		return results.join(",") === expected.join(",")
			? undefined
			: `results [${results.join(",")}] where [${expected.join(",")}] were expected`;
	};

	const respond = async (context: TranscriptContext): Promise<AssistantMessage> => {
		// A provider's reply arrives as I/O: the event loop turns between requests, as it does in a real session.
		await new Promise((resolve) => setImmediate(resolve));
		seen.requests += 1;
		const where = `request ${seen.requests} (turn ${(turn?.index ?? -1) + 1})`;
		const system = getCurrentSystemMessage(context.messages);
		const standalone = system?.content === SUMMARIZATION_SYSTEM_PROMPT;
		const tail = context.messages.at(-1);
		if (standalone || (tail?.role === "user" && textOf(tail).includes(SHARED_SUMMARY_PROMPT))) {
			seen.summaryRequests += 1;
			const summary = summaries.shift();
			if (summary !== undefined) seen.recordedSummariesUsed += 1;
			return fauxAssistantMessage(summary ?? REPLAY_CHECKPOINT);
		}
		const segment = seen.compactionsSeen;
		const fingerprint = systemFingerprint(context);
		const systems = seen.systemsBySegment[segment] ?? new Set();
		seen.systemsBySegment[segment] = systems;
		if (systems.size > 0 && !systems.has(fingerprint)) {
			const [first] = systems;
			seen.systemChanges.push(`${where}: ${changedSections(first, fingerprint)}`);
		}
		systems.add(fingerprint);
		(seen.toolArraysBySegment[segment] ??= new Set()).add(JSON.stringify(getCurrentTools(context.messages)));
		const view = providerView(context.messages, where);
		const size = view.reduce((sum, part) => sum + part.length, 0);
		seen.peakContextChars = Math.max(seen.peakContextChars, size);
		if (compacted) seen.contextAfterCompaction.push(size);
		else if (cleared) seen.requestsAfterClearing += 1;
		else if (previous) {
			const at = previous.findIndex((part, index) => view[index] !== part);
			if (at >= 0)
				seen.prefixBreaks.push(
					`${where}: message ${at} of ${previous.length} changed (${previous[at].slice(0, 160)} -> ${(view[at] ?? "<none>").slice(0, 160)})`,
				);
		}
		compacted = false;
		cleared = false;
		previous = view;

		const off = divergence(context);
		if (off) {
			const tail = context.messages
				.slice(-4)
				.map((message) => `${message.role}: ${textOf(message).replace(/\s+/g, " ").slice(0, 100)}`);
			seen.diverged.push(`${where}: ${off}; the request ends with [${tail.join(" | ")}]`);
		}
		const wasFirst = firstOfTurn;
		firstOfTurn = false;
		const next = plan.shift();
		if (next) {
			last = next;
			// Sent now, as a provider's reply would be: a recorded timestamp would make every cache look expired, and recorded
			// timings would keep the stream from timing the replay.
			const { durationMs: _duration, firstTokenMs: _firstToken, longestGapMs: _gap, ...reply } = structuredClone(next);
			return { ...reply, timestamp: Date.now() };
		}
		if (wasFirst) seen.unanswered += 1;
		else if (callIds(last).length > 0) seen.runTails += 1;
		else seen.unscripted.push(where);
		last = fauxAssistantMessage("[replay] The recording has no reply here.");
		return last;
	};

	return {
		seen,
		respond,
		/** Called before each turn's trigger is sent. */
		beginTurn(next: ReplayTurn) {
			turn = next;
			plan = [...next.replies];
			firstOfTurn = true;
		},
		/** Called on each `compaction_end` with a result. */
		compactionDone() {
			seen.compactionsSeen += 1;
			compacted = true;
		},
		/** Called when the session saves a decision to clear old tool results. */
		clearingDone() {
			seen.clearings += 1;
			cleared = true;
		},
		/** Replies of the current turn that no request asked for. */
		leftover: () => plan.length,
	};
}
