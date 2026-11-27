import { setImmediate } from "node:timers/promises";
import { sessions as sessionRows, transcripts } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { HistorySession } from "./transcripts.ts";
import { paginate } from "./transcripts.ts";
import { classifyError } from "./errors-signature.ts";
import { matchTexts } from "./search.ts";
import { clip, oneLine, plural } from "../shared/text.ts";
import { attachEmitted, type Sample, sampleAnchors } from "./errors-samples.ts";

export { errorSignature } from "./errors-signature.ts";

/**
 * Finding errors in history without a model: streams the database mirrors of the sessions in scope, and
 * groups every tool result marked as an error by tool and a signature (`errors-signature.ts`), with counts,
 * sessions, models, dates, samples, what the next call to the same tool did, and error rates by tool, model and day.
 * A bash command's own failure (a test, linter or formatter exiting non-zero) is grouped apart from refusals by the
 * harness. The `archive` tool's `errors` mode renders it, so recurring tool mistakes are measured instead of read one
 * by one, and a fix shows as a falling rate in the days after it.
 */

/** Samples kept per group. */
const SAMPLES = 2;
/** Characters of a sample's error text. */
const SAMPLE_CHARS = 240;
/** How far into a line the entry kind, time and tool name are looked for before the line is parsed. */
const HEAD_CHARS = 400;
/** Days shown in the trend, the latest ones. */
const TREND_DAYS = 14;
/** Characters of error text gathered before a query filter tests them in the archive-search worker. */
const FILTER_BATCH_CHARS = 8 * 1024 * 1024;

/** One tool result of a transcript, in order; `error` is set when it failed. */
interface ToolResult {
	tool: string;
	error?: {
		text: string;
		at: string;
		model: string;
		callId?: string;
		command?: string;
		/** The result entry's id and the assistant entry that emitted the call. */
		entry?: string;
		callEntry?: string;
	};
}

/** What the next call to the same tool, later in the same transcript, was. */
interface Followed {
	/** It succeeded: the mistake was corrected, or the call changed. */
	ok: number;
	/** It failed too. */
	error: number;
	/** There was none: the session ended or moved on. */
	none: number;
}

interface ErrorGroup {
	tool: string;
	signature: string;
	/** A bash command's own failure, not a refusal or a tool mistake. */
	command: boolean;
	followed: Followed;
	count: number;
	sessions: Set<string>;
	models: Map<string, number>;
	first: string;
	last: string;
	samples: Sample[];
}

export interface HistoryErrors {
	sessions: number;
	transcripts: number;
	/** Sessions whose record names no transcript this session may read. */
	unread: number;
	/** The ISO time results were counted from, when a window was asked for. */
	since?: string;
	results: number;
	errors: number;
	/** Tool results per tool, errors included. */
	resultsByTool: Map<string, number>;
	errorsByTool: Map<string, number>;
	errorsByModel: Map<string, number>;
	/** Tool results and errors per UTC day (`YYYY-MM-DD`). */
	byDay: Map<string, { results: number; errors: number }>;
	groups: ErrorGroup[];
}

export interface FindErrorsOptions {
	/** Keeps errors whose tool name or text it matches; the totals still count every result. */
	filter?: RegExp;
	/** An ISO time: only results at or after it count, errors and totals alike. */
	since?: string;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

/** `since` as a canonical ISO time; throws a correctable message when it is not a date or time. */
export function sinceTime(since: string): string {
	const at = Date.parse(since);
	if (Number.isNaN(at))
		throw new Error(
			`since must be an ISO date or time such as 2026-10-30 or 2026-10-30T12:00Z, not ${JSON.stringify(since)}.`,
		);
	return new Date(at).toISOString();
}

const bump = (counts: Map<string, number>, key: string): void => {
	counts.set(key, (counts.get(key) ?? 0) + 1);
};

const errorText = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map((part: { type?: unknown; text?: unknown }) =>
					part?.type === "text" && typeof part.text === "string" ? part.text : "",
				)
				.join("\n")
		: typeof content === "string"
			? content
			: "";

/** A bash call in an assistant line: its id and the start of its command (the arguments' other keys come first or not at all). */
const BASH_CALL =
	/"type":"toolCall","id":"([^"]+)","name":"bash","arguments":\{(?:"\w+":"(?:[^"\\]|\\.)*",)*?"command":"((?:[^"\\]|\\.){0,300})/g;
/** A tool call in an assistant line: its id. */
const TOOL_CALL = /"type":"toolCall","id":"([^"]+)"/g;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\n" };
const unescape = (json: string): string => json.replace(/\\(.)/g, (_, char: string) => ESCAPES[char] ?? char);

function parse(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every error tool result in the transcripts of `sessions`, grouped and ranked by count. Only lines that look like tool
 * results are parsed, so large transcripts stream cheaply.
 */
export async function findErrors(
	sessions: readonly HistorySession[],
	{ filter, since, signal, env = process.env }: FindErrorsOptions = {},
): Promise<HistoryErrors> {
	const found: HistoryErrors = {
		sessions: sessions.length,
		transcripts: 0,
		unread: 0,
		...(since ? { since } : {}),
		results: 0,
		errors: 0,
		resultsByTool: new Map(),
		errorsByTool: new Map(),
		errorsByModel: new Map(),
		byDay: new Map(),
		groups: [],
	};
	const groups = new Map<string, ErrorGroup>();
	const agent = sharedAgentDb(env);
	const db = agent.mirror.db;
	// Transcripts read but not yet grouped: a query filter is a model-supplied regex, so it runs over their error texts
	// in the bounded search worker, never on this thread.
	const batch: Array<{ session: string; results: ToolResult[] }> = [];
	let batched = 0;
	const flush = async (): Promise<void> => {
		const errors = batch.flatMap(({ results }) =>
			results.flatMap(({ tool, error }) => (error ? [`${tool}\n${error.text}`] : [])),
		);
		const matched = filter ? await matchTexts(errors, filter, signal) : undefined;
		let position = 0;
		for (const { session, results } of batch) {
			// The group of each tool's latest error, until that tool's next result says what followed it.
			const pending = new Map<string, ErrorGroup>();
			for (const { tool, error } of results) {
				const earlier = pending.get(tool);
				if (earlier) {
					earlier.followed[error ? "error" : "ok"]++;
					pending.delete(tool);
				}
				if (!error || (matched && !matched.has(position++))) continue;
				pending.set(tool, addError(groups, found, session, tool, error));
			}
			// An error with no later call to its tool in this transcript was followed by nothing.
			for (const group of pending.values()) group.followed.none++;
		}
		batch.length = 0;
		batched = 0;
	};
	for (const session of sessions) {
		signal?.throwIfAborted();
		const mirror = transcripts.stamp(db, session.id);
		if (!mirror || sessionRows.byId(agent.db, session.id)?.workspace_id !== session.workspaceId) {
			found.unread++;
			continue;
		}
		found.transcripts++;
		let model = "unknown model";
		// Shell commands by call id, to name the program of a command that failed.
		const commands = new Map<string, string>();
		// The assistant entry that emitted each call, so an error sample can open the call (name and arguments).
		const callEntries = new Map<string, string>();
		const results: ToolResult[] = [];
		try {
			let scanned = 0;
			for (const line of transcripts.entries(db, session.id)) {
				scanned += line.length;
				if (scanned >= 1024 * 1024) {
					scanned = 0;
					await setImmediate();
				}
				signal?.throwIfAborted();
				const head = line.slice(0, HEAD_CHARS);
				if (head.includes('"type":"model_change"')) {
					const entry = parse(line);
					if (typeof entry?.modelId === "string") model = entry.modelId;
					continue;
				}
				if (head.includes('"role":"assistant"')) {
					if (line.includes('"type":"toolCall"')) {
						const entry = /"id":"([^"]+)"/.exec(head)?.[1];
						if (entry) for (const call of line.matchAll(TOOL_CALL)) callEntries.set(call[1], entry);
					}
					if (line.includes('"name":"bash"'))
						for (const call of line.matchAll(BASH_CALL)) commands.set(call[1], unescape(call[2]));
					continue;
				}
				if (!head.includes('"role":"toolResult"')) continue;
				const at = /"timestamp":"([^"]+)"/.exec(head)?.[1] ?? "";
				if (since && !(at >= since)) continue;
				const tool = /"toolName":"([^"]+)"/.exec(head)?.[1] ?? "unknown tool";
				const day = found.byDay.get(at.slice(0, 10)) ?? { results: 0, errors: 0 };
				if (at) found.byDay.set(at.slice(0, 10), day);
				found.results++;
				day.results++;
				bump(found.resultsByTool, tool);
				// A line that names the flag is parsed to be sure: an ordinary result's text may quote it.
				const message = line.includes('"isError":true')
					? (parse(line)?.message as Record<string, unknown> | undefined)
					: undefined;
				if (message?.isError !== true) {
					results.push({ tool });
					continue;
				}
				const text = errorText(message.content);
				const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
				const command = callId ? commands.get(callId) : undefined;
				const entry = /"id":"([^"]+)"/.exec(head)?.[1];
				const callEntry = callId ? callEntries.get(callId) : undefined;
				results.push({
					tool,
					error: {
						text,
						at,
						model,
						...(callId ? { callId } : {}),
						...(command ? { command } : {}),
						...(entry ? { entry } : {}),
						...(callEntry ? { callEntry } : {}),
					},
				});
				batched += text.length;
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			// A transcript that cannot be read to its end keeps what was counted before the failure.
		}
		batch.push({ session: session.id, results });
		if (!filter || batched >= FILTER_BATCH_CHARS) await flush();
	}
	await flush();
	attachEmitted(
		db,
		[...groups.values()].flatMap((group) => group.samples),
	);
	// Refusals and tool mistakes first: a command's own failure is the work, so it ranks after them.
	found.groups = [...groups.values()].sort(
		(a, b) => Number(a.command) - Number(b.command) || b.count - a.count || b.sessions.size - a.sessions.size,
	);
	return found;
}

/** Counts one error result into its group (made on first sight) and the totals; returns the group. */
function addError(
	groups: Map<string, ErrorGroup>,
	found: HistoryErrors,
	session: string,
	tool: string,
	{ text, at, model, callId, command: commandText, entry, callEntry }: NonNullable<ToolResult["error"]>,
): ErrorGroup {
	const { signature, command } = classifyError(text, commandText);
	const key = `${tool}\u0000${signature}`;
	let group = groups.get(key);
	if (!group) {
		group = {
			tool,
			signature,
			command,
			followed: { ok: 0, error: 0, none: 0 },
			count: 0,
			sessions: new Set(),
			models: new Map(),
			first: at,
			last: at,
			samples: [],
		};
		groups.set(key, group);
	}
	group.count++;
	group.sessions.add(session);
	bump(group.models, model);
	if (at && (!group.first || at < group.first)) group.first = at;
	if (at > group.last) group.last = at;
	if (group.samples.length < SAMPLES)
		group.samples.push({
			session,
			at,
			call: callId ?? "?",
			text: clip(oneLine(text), SAMPLE_CHARS),
			...(entry ? { entry } : {}),
			...(callEntry ? { callEntry } : {}),
		});
	found.errors++;
	const day = found.byDay.get(at.slice(0, 10));
	if (at && day) day.errors++;
	bump(found.errorsByTool, tool);
	bump(found.errorsByModel, model);
	return group;
}

const ranked = (counts: Map<string, number>): Array<[string, number]> => [...counts].sort((a, b) => b[1] - a[1]);
const percent = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "0%");
const dayOf = (iso: string): string => iso.slice(0, 10) || "?";

/** What the next call to the group's tool did after its errors: succeeded (the mistake was corrected), failed again, or never came. */
function followedLine({ tool, followed, count }: ErrorGroup): string {
	const part = (label: string, n: number) => `${label} ${n} (${percent(n, count)})`;
	return `next ${tool} call: ${part("ok", followed.ok)} · ${part("error again", followed.error)} · ${part("none", followed.none)}`;
}

/** The errors as text: totals, error rates by tool, model and day, then the groups ranked by count, paged. */
export function renderErrors(found: HistoryErrors, page = 1): { text: string; page: number; pages: number } {
	const { results, errors } = found;
	const commandErrors = found.groups.reduce((sum, group) => sum + (group.command ? group.count : 0), 0);
	const days = [...found.byDay].sort((a, b) => a[0].localeCompare(b[0])).slice(-TREND_DAYS);
	const summary = [
		`${plural(errors, "tool error")} in ${plural(results, "tool result")} (${percent(errors, results)})${found.since ? ` since ${found.since}` : ""}, from ${plural(found.transcripts, "transcript")} of ${plural(found.sessions, "session")}; ${plural(found.unread, "session")} without a readable transcript.`,
		`By tool: ${
			ranked(found.errorsByTool)
				.map(([tool, count]) => {
					const total = found.resultsByTool.get(tool) ?? count;
					return `${tool} ${count}/${total} (${percent(count, total)})`;
				})
				.join(" · ") || "none"
		}`,
		...(commandErrors
			? [
					`Of the ${plural(errors, "error")}, ${commandErrors} (${percent(commandErrors, errors)}) are a bash command's own failure (a test, linter or formatter exiting non-zero: the work, not a tool mistake); those groups come after the refusals and tool mistakes.`,
				]
			: []),
		`By model: ${
			ranked(found.errorsByModel)
				.map(([model, count]) => `${model} ${count}`)
				.join(" · ") || "none"
		}`,
		`By day (UTC, latest ${TREND_DAYS}): ${
			days
				.map(([day, count]) => `${day} ${count.errors}/${count.results} (${percent(count.errors, count.results)})`)
				.join(" · ") || "none"
		}`,
	];
	const blocks = found.groups.map((group, index) => ({
		heading: `## ${index + 1}. ${group.tool} · ${plural(group.count, "error")} · ${plural(group.sessions.size, "session")} · ${dayOf(group.first)} → ${dayOf(group.last)}${group.command ? " · command failure" : ""}`,
		lines: [
			group.signature,
			followedLine(group),
			`models: ${ranked(group.models)
				.map(([model, count]) => `${model} ${count}`)
				.join(" · ")}`,
			...group.samples.flatMap((sample) => [
				`- ${sample.session} · ${sample.at || "?"} · ${sample.call}: ${sample.text}`,
				...(sample.emitted ? [`  emitted: ${sample.emitted}`] : []),
				...sampleAnchors(sample),
			]),
			"",
		],
	}));
	const pages = paginate([{ lines: [...summary, ""] }, ...blocks]);
	const index = Math.min(Math.max(page, 1), pages.length);
	return { text: pages[index - 1] ?? "", page: index, pages: pages.length };
}
