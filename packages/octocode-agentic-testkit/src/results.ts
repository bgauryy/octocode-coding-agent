import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TestContext } from "vitest";
import type { ComparisonSummary } from "./compare.ts";
import type { Judgement } from "./judge.ts";
import type { LiveSummary } from "./live.ts";
import type { ProcessRun } from "./process.ts";
import type { Trace } from "./trace.ts";

const TAIL = 20000;
const ARGS_MAX = 120;
const SECRET = /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;

export interface ResultData {
	trace?: Trace;
	live?: LiveSummary;
	/** A `runComparison` summary (also on `meta.compare` of a `liveCompare` test). */
	compare?: ComparisonSummary;
	judgement?: Judgement;
	/** Usually a `ProcessRun`: `stdout` and `stderr` keep their last 20000 characters. */
	run?: unknown;
	note?: string;
}

export interface ResultSummary {
	file: string;
	test: string;
	state: string;
	requests: number;
	events: number;
	failedChecks?: string[];
}

const tail = (s: unknown): unknown => (typeof s === "string" && s.length > TAIL ? s.slice(-TAIL) : s);

function trimRun(run: unknown): unknown {
	if (typeof run !== "object" || run === null) return run;
	const r = run as Partial<ProcessRun>;
	return { ...r, stdout: tail(r.stdout), stderr: tail(r.stderr) };
}

function fullName(ctx: TestContext): string {
	const names: string[] = [];
	for (let t: { name: string; suite?: unknown } | undefined = ctx.task; t; t = t.suite as typeof t) {
		if (t.name) names.push(t.name);
	}
	return names.toReversed().join(" > ");
}

/** Write what a test observed to `$TESTKIT_RESULTS_DIR`; returns the path, or `undefined` when the variable is unset. */
export function saveResult(ctx: TestContext, data: ResultData): string | undefined {
	const root = process.env.TESTKIT_RESULTS_DIR;
	if (!root) return undefined;
	const name = fullName(ctx);
	const abs = ctx.task.file?.filepath ?? "";
	const file = abs ? relative(process.cwd(), abs) : "unknown";
	const dir = join(root, file.replaceAll("/", "__").replaceAll("\\", "__"));
	const path = join(dir, `${name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || "test"}.json`);
	const body = {
		test: name,
		file,
		state: ctx.task.result?.state ?? "running",
		savedAt: new Date().toISOString(),
		trace: data.trace?.toJSON(),
		live: data.live,
		compare: data.compare,
		judgement: data.judgement,
		run: trimRun(data.run),
		note: data.note,
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(body, null, 2).replace(SECRET, "<secret>"));
	(ctx.task.meta as Record<string, unknown>).testkitResult = path;
	return path;
}

type Json = Record<string, any>;

/** The agent reporter's JSON (`…/reporter`); read by the HTML report, never listed as a result. */
export const AGENT_REPORT_FILE = "testkit-agent-report.json";

function jsonFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? jsonFiles(join(dir, e.name))
			: e.name.endsWith(".json") && e.name !== AGENT_REPORT_FILE
				? [join(dir, e.name)]
				: [],
	);
}

function failedChecks(j: Json): string[] {
	const out: string[] = [];
	for (const v of j.judgement?.criteria ?? []) if (!v.pass) out.push(String(v.id ?? v.criterion));
	if (j.live?.decision === "fail") out.push("live");
	return out;
}

/** A saved result as read back: where it lives, its JSON and its summary row. */
export interface SavedResult {
	path: string;
	json: Json;
	summary: ResultSummary;
}

/** Sort rank: failed tests first, then tests with failed checks, then the rest. */
const rank = (r: ResultSummary): number => (r.state === "fail" ? 0 : r.failedChecks ? 1 : 2);

/** Every saved result under `dir`, failures first, then by file and test. */
export function loadResults(dir: string): SavedResult[] {
	const rows = jsonFiles(dir).map((path): SavedResult => {
		const json = JSON.parse(readFileSync(path, "utf8")) as Json;
		const failed = failedChecks(json);
		const summary: ResultSummary = {
			file: String(json.file),
			test: String(json.test),
			state: String(json.state),
			requests: json.trace?.requests?.length ?? 0,
			events: json.trace?.events?.length ?? 0,
		};
		if (failed.length) summary.failedChecks = failed;
		return { path, json, summary };
	});
	return rows.toSorted(
		({ summary: a }, { summary: b }) =>
			rank(a) - rank(b) || a.file.localeCompare(b.file) || a.test.localeCompare(b.test),
	);
}

/** One row per saved result, failures first. */
export function summarizeResults(dir: string): ResultSummary[] {
	return loadResults(dir).map((r) => r.summary);
}

const cell = (v: unknown, max = ARGS_MAX): string => {
	const s = v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
	return (s.length > max ? `${s.slice(0, max)}…` : s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
};

/** Markdown for one saved result. */
export function renderResult(json: unknown): string {
	const j = json as Json;
	const out = [`# ${j.test}`, "", `- file: ${j.file}`, `- state: ${j.state}`, `- saved: ${j.savedAt}`];
	if (j.note) out.push(`- note: ${j.note}`);
	if (j.live) out.push("", "## Live", "", "```json", JSON.stringify(j.live, null, 2), "```");
	if (j.compare) out.push("", "## Compare", "", "```json", JSON.stringify(j.compare, null, 2), "```");
	if (j.judgement) {
		out.push("", `## Judgement: ${j.judgement.pass ? "pass" : "fail"}`, "");
		for (const v of j.judgement.criteria ?? []) out.push(`- ${v.pass ? "pass" : "FAIL"} ${v.id}: ${v.reason}`);
	}
	const events: Json[] = j.trace?.events ?? [];
	out.push("", "## Events", "", "| seq | agent | kind | name | args |", "| --- | --- | --- | --- | --- |");
	for (const e of events) out.push(`| ${e.seq} | ${cell(e.agent)} | ${e.kind} | ${cell(e.name)} | ${cell(e.args)} |`);
	const requests: Json[] = j.trace?.requests ?? [];
	out.push("", "## Requests", "", "| index | agent | model | bytes | usage |", "| --- | --- | --- | --- | --- |");
	for (const r of requests)
		out.push(`| ${r.index} | ${cell(r.agent)} | ${cell(r.model)} | ${r.bytes} | ${cell(r.usage, 200)} |`);
	return `${out.join("\n")}\n`;
}
