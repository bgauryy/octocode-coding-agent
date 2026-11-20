import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { runOctocodeAgent } from "../../src/adapters/octocode-agent/index.ts";
import type { Responder } from "../../src/gateway.ts";
import type { Step } from "../../src/script.ts";
import { type CapturedRequest, type ChatMessage, textOf } from "../../src/trace.ts";
import type { gateway } from "../helpers.ts";
import { anthropicHome, traceRows } from "./cache-trace.ts";

/**
 * Shared scaffolding of the context-flow guards: one scripted run of the real bundle against the scripted gateway, and
 * finders that turn the requests the gateway captured into a list of violations (empty: the flow behaved). Each finder
 * judges only what reaches the wire, so it holds for any agent that implements the flow, and each one has a negative
 * run in the guard that proves it reports the broken case.
 */

export const FLAGS = ["--mode", "json", "--no-session", "--offline", "--trust", "--model", "testkit/scripted"];

/**
 * Characters per token the agent estimates for the `scripted` model, a model of no known tokenizer family: the default
 * ratio in octocode-agent's estimator (`CHARS_PER_TOKEN` in `packages/ai/src/utils/estimate.ts`, Claude's measured
 * density). A gateway that counts at it reports what the agent's own estimate expects, as a real provider of that family
 * would; the testkit imports no workspace, so the value is kept here.
 */
export const SCRIPTED_CHARS_PER_TOKEN = 2.5;

/** `lines` lines of `width` bytes each (newline included), every one tagged with `tag` so a result can be told apart. */
export function block(tag: string, lines: number, width = 400): string {
	return Array.from({ length: lines }, (_, i) => `${tag} ${i} `.padEnd(width - 1, "x")).join("\n") + "\n";
}

export interface FlowRun {
	requests: CapturedRequest[];
	exitCode: number | null;
	stderr: string;
	workspace: string;
	home: string;
	/** Whether `file` (absolute, or relative to the workspace) exists and contains `marker`; read before the home is removed. */
	saved: Map<string, string>;
}

export interface FlowOptions {
	responder: Responder;
	turns: string[];
	files: Record<string, string>;
	contextWindow: number;
	settings?: Record<string, unknown>;
	model?: Record<string, unknown>;
	/** MCP servers to list in mcp.json, each with the tool roles it declares (`reader`: tools whose reads count). */
	mcp?: Record<string, { url: string; roles?: Record<string, string[]> }>;
	mcpMocks?: { name: string; listen(): Promise<string> }[];
	/** Paths named in tool results to read back before the run's home is removed. */
	keep?: (requests: CapturedRequest[]) => string[];
}

/** One `--mode json` run: the turns before the last go as extra arguments, the last as the prompt. */
export async function runFlow(
	gw: Awaited<ReturnType<typeof gateway>>,
	opts: Omit<FlowOptions, "responder">,
): Promise<FlowRun> {
	const home = anthropicHome({
		gatewayUrl: gw.url,
		contextWindow: opts.contextWindow,
		model: opts.model,
		settings: opts.settings,
	});
	try {
		if (opts.mcp) {
			const mcpServers: Record<string, unknown> = {};
			for (const [name, { url, roles }] of Object.entries(opts.mcp))
				mcpServers[name] = { url, headers: { "x-testkit-agent": "main", "x-testkit-span": "main" }, roles };
			writeFileSync(join(home.home, "mcp.json"), JSON.stringify({ mcpServers }));
		}
		const run = await runOctocodeAgent({
			keep: true,
			gatewayUrl: gw.url,
			args: [...FLAGS, ...opts.turns.slice(0, -1)],
			prompt: opts.turns.at(-1) ?? "",
			files: opts.files,
			env: { OCTOCODE_HOME: home.home },
			timeoutMs: 150_000,
		});
		const requests = [...gw.trace.requests];
		const saved = new Map<string, string>();
		try {
			for (const file of opts.keep?.(requests) ?? []) {
				const at = isAbsolute(file) ? file : join(run.workspace, file);
				if (existsSync(at)) saved.set(file, readFileSync(at, "utf8"));
			}
		} finally {
			// The adapter keeps its run root (`keep`) so saved copies can be read; it is the workspace's parent.
			rmSync(dirname(run.workspace), { recursive: true, force: true });
		}
		return { requests, exitCode: run.exitCode, stderr: run.stderr, workspace: run.workspace, home: home.home, saved };
	} finally {
		home.close();
	}
}

/** Where a main request stands: the last user turn tagged `T<n> ` and the assistant replies since. */
/** The cache-sharing summary request's ask, its last user message (`shared-request.md`). */
const SUMMARY_REQUEST = /write a context checkpoint summary/;

export function position(request: CapturedRequest): { turn: string; replies: number } {
	const at = request.messages.findLastIndex((m) => m.role === "user" && /^T\d /.test(textOf(m.content)));
	const turn = at < 0 ? "" : textOf(request.messages[at].content).slice(0, 2);
	return { turn, replies: request.messages.slice(at + 1).filter((m) => m.role === "assistant").length };
}

/**
 * A responder scripted per turn: `steps[turn][k]` answers the k-th main request of that turn, and an unscripted turn
 * gets one text reply. A request that asks for the checkpoint (the cache-sharing summary request, which keeps the
 * tools, after a compaction too) and every request without tools gets `summary` and is recorded. Past the end of a
 * turn's script, a request answering a tool result, or one whose user side carries the scripted summary (the turn
 * continuing after a compaction), gets the turn's closing text; any other request past the script gets `summary`.
 */
export function byTurn(
	steps: Record<string, Step[]>,
	summary: string,
): { responder: Responder; summaryRequests: CapturedRequest[] } {
	const summaryRequests: CapturedRequest[] = [];
	const responder: Responder = ({ request }) => {
		const asked = textOf(request.messages.findLast((m) => m.role === "user")?.content);
		if (request.tools.length === 0 || SUMMARY_REQUEST.test(asked)) {
			summaryRequests.push(request);
			return { text: summary };
		}
		const { turn, replies } = position(request);
		const script = steps[turn] ?? [{ text: `${turn} done` }];
		const step = request.tools.length === 0 ? undefined : script[replies];
		if (step) return step;
		const lastReply = request.messages.findLastIndex((m) => m.role === "assistant");
		const afterTool = request.messages.slice(lastReply + 1).some((m) => m.role === "tool");
		const compacted = request.messages.some((m) => m.role === "user" && textOf(m.content).includes(summary));
		if (request.tools.length > 0 && (afterTool || compacted)) return { text: `${turn} done` };
		summaryRequests.push(request);
		return { text: summary };
	};
	return { responder, summaryRequests };
}

/** The messages of `request` from the first one that differs from `before`'s (all of them when none came before). */
export function addedMessages(request: CapturedRequest, before?: CapturedRequest): ChatMessage[] {
	if (!before) return request.messages;
	// Role and text only: cache markers move between requests without changing what the model reads.
	const shape = (m: ChatMessage | undefined): string => (m ? `${m.role}\n${textOf(m.content)}` : "");
	const at = request.messages.findIndex((m, i) => shape(m) !== shape(before.messages[i]));
	return at < 0 ? [] : request.messages.slice(at);
}

export interface RestoreExpectation {
	/** Texts that must come back whole (a file the agent changed). */
	whole: Record<string, string>;
	/** Texts that must not come back whole (a file only read). */
	notWhole: Record<string, string>;
	/** Markers that must not appear at all (a scratch file's text). */
	absent: Record<string, string>;
}

/** The first main request after the summary request, and what it carries that the summary request did not. */
export function afterCompaction(run: FlowRun, summaryRequest: CapturedRequest): CapturedRequest | undefined {
	const at = run.requests.findIndex((r) => r.index === summaryRequest.index);
	return at < 0 ? undefined : mainRequests(run.requests.slice(at + 1))[0];
}

/** Post-compaction restore as the wire shows it: in the first request after the compaction. */
export function restoreViolations(after: CapturedRequest | undefined, expect: RestoreExpectation): string[] {
	if (!after) return ["no request after the compaction"];
	const text = after.messages.map((m) => textOf(m.content)).join("\n");
	const out: string[] = [];
	for (const [name, body] of Object.entries(expect.whole)) if (!text.includes(body)) out.push(`${name} not whole`);
	for (const [name, body] of Object.entries(expect.notWhole))
		if (text.includes(body)) out.push(`${name} came back whole`);
	for (const [name, marker] of Object.entries(expect.absent)) if (text.includes(marker)) out.push(`${name} came back`);
	return out;
}

/**
 * Bash output budget as the wire shows it: the result of a command whose output far exceeds `budget` bytes fits the
 * budget (with `slack` bytes for the status line and the saved-log notice), keeps a marker of the output, and names a
 * saved log that holds the whole output (`lastMarker`).
 */
export function budgetViolations(
	result: string | undefined,
	saved: Map<string, string>,
	budget: number,
	markers: { first: string; last: string },
	slack = 600,
): string[] {
	if (result === undefined) return ["no bash result"];
	const out: string[] = [];
	if (bytes(result) > budget + slack) out.push(`result is ${bytes(result)} bytes, over ${budget} + ${slack}`);
	if (!result.includes(markers.first) && !result.includes(markers.last)) out.push("result shows none of the output");
	const log = namedPaths(result).find((p) => saved.get(p)?.includes(markers.last));
	if (!log) out.push("result names no saved log holding the whole output");
	return out;
}

/** The main conversation's requests: the summary request is the one without tools. */
export const mainRequests = (requests: CapturedRequest[]): CapturedRequest[] =>
	requests.filter((r) => r.tools.length > 0);

export const toolResults = (request: CapturedRequest): ChatMessage[] =>
	request.messages.filter((m) => m.role === "tool");

export const bytes = (text: string): number => Buffer.byteLength(text);

/** File paths a tool result names (absolute, or under the workspace's `.octocode/`), in order. */
export function namedPaths(text: string): string[] {
	return [...text.matchAll(/(?:\/|\.octocode\/)[^\s"'`()[\]<>,]+\.(?:txt|log)\b/g)].map((m) => m[0]);
}

/** Request indexes (into `main`) whose messages edit earlier bytes instead of appending. */
export function editWaves(main: CapturedRequest[]): number[] {
	return traceRows(main)
		.map((row, i) => (row.change.messages.kind === "edit" ? i : -1))
		.filter((i) => i >= 0);
}

export interface ClearingExpectation {
	/** Result order (0-based among tool results) of the old results that must be cleared. */
	cleared: number[];
	/** Result order of results that must arrive whole, each with a marker its text holds. */
	kept: Array<[number, string]>;
	/** Markers of the cleared results' text, in the order of `cleared`. */
	markers: string[];
}

/**
 * Stale-result clearing as the wire shows it: in the last request the `cleared` results lost their text (none of their
 * marker, under a tenth of the original bytes) and name a saved copy that holds it; `kept` results are whole; the clear
 * is exactly one edit of earlier bytes, and every request after it appends.
 */
export function clearingViolations(run: FlowRun, expect: ClearingExpectation, originalBytes: number): string[] {
	const out: string[] = [];
	const main = mainRequests(run.requests);
	const last = main.at(-1);
	if (!last) return ["no main request captured"];
	const results = toolResults(last).map((m) => textOf(m.content));
	expect.cleared.forEach((at, i) => {
		const text = results[at] ?? "";
		if (text.includes(expect.markers[i])) out.push(`result ${at} still carries its text`);
		else if (bytes(text) * 10 > originalBytes) out.push(`result ${at} shrank only to ${bytes(text)} bytes`);
		const copy = namedPaths(text).find((p) => run.saved.has(p));
		if (!copy) out.push(`result ${at} names no saved copy that exists`);
		else if (!run.saved.get(copy)?.includes(expect.markers[i])) out.push(`saved copy of result ${at} lacks its text`);
	});
	for (const [at, marker] of expect.kept)
		if (!results[at]?.includes(marker)) out.push(`result ${at} was not kept whole`);
	const waves = editWaves(main);
	if (waves.length !== 1) out.push(`expected one edit wave, saw ${waves.length} (${waves.join(",")})`);
	else if (waves[0] === main.length - 1) out.push("the clear was the last request: nothing appended after it");
	return out;
}

/** No request carries a cleared result and every request appends to the one before. */
export function noClearingViolations(run: FlowRun, markers: string[]): string[] {
	const out: string[] = [];
	const main = mainRequests(run.requests);
	const results = toolResults(main.at(-1) ?? ({ messages: [] } as unknown as CapturedRequest)).map((m) =>
		textOf(m.content),
	);
	for (const marker of markers)
		if (!results.some((text) => text.includes(marker))) out.push(`result ${marker} was cleared`);
	const waves = editWaves(main);
	if (waves.length) out.push(`earlier bytes were edited at request ${waves.join(",")}`);
	return out;
}
