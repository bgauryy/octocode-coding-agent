import { storedText } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { notify } from "../../shared/commands.ts";
import { publishUserNotice } from "../../shared/user-notice.ts";
import { BACKGROUND_RETRY } from "../../shared/side-retry.ts";
import type { SmallModel as SmallModelOf } from "../../shared/small-model.ts";
import type { MemoryStore } from "../store.ts";
import { type MemoryOp, parseMemoryOps } from "./consolidate.ts";
import { type Defect, parseDefects } from "./defects.ts";
import {
	countedLines,
	lineCap,
	lineProblem,
	type MemoryLine,
	memoryLineKey,
	type MemorySection,
	parseMemoryFile,
	serializeMemoryFile,
} from "./format.ts";
import type { MemoryFileRef, MemoryFileScope } from "../../permission/memory-files.ts";
import { adoptFileLines, archive } from "./sync.ts";
import { MemoryFileError, MemoryFileTrackedError, readMemoryFile, updateMemoryFile } from "./writer.ts";

/**
 * What the reflection and consolidation passes (`reflect.ts`) share: reading the files for a prompt, one call to the
 * `small` model, its reply as ops, and applying them. The model only proposes: code parses the ops (`parseMemoryOps`),
 * marks them as the reflection's, holds back quarantined text, and the writer validates every change. A reply that is
 * not the JSON asked for leaves both files unchanged. Each pass is recorded in the session (`MEMORY_PASS_TYPE`).
 */

export type SmallModel = SmallModelOf<FeatureContext>;

/** The session entry a pass writes: what it changed, held back or refused, for `/memory` and a later look. */
export const MEMORY_PASS_TYPE = "octocode-memory-pass";

export interface PassFile {
	ref: MemoryFileRef;
	lines: MemoryLine[];
}

const LABEL: Record<MemoryFileScope, string> = { global: "global MEMORY.md", workspace: "workspace MEMORY.md" };

/** Each file as a pass reads it; one with content Octocode cannot place is left out, since its writer would refuse it. */
export async function readPassFiles(
	refs: readonly MemoryFileRef[],
	env: NodeJS.ProcessEnv,
): Promise<{ files: PassFile[]; unreadable: string[] }> {
	const files: PassFile[] = [];
	const unreadable: string[] = [];
	for (const ref of refs) {
		const parsed = parseMemoryFile((await readMemoryFile(ref, env)) ?? "");
		if (parsed.problems.length > 0) unreadable.push(`${LABEL[ref.scope]} has content to fix by hand`);
		else files.push({ ref, lines: parsed.lines });
	}
	return { files, unreadable };
}

/** The files as a prompt shows them: a heading with the line count, then the file as it is written (`!` pins). */
export function filesBlock(files: readonly PassFile[]): string {
	return files
		.map((file) =>
			[
				`### ${file.ref.scope} (${countedLines(file.lines)}/${lineCap(file.ref.scope)} lines with headings)`,
				file.lines.length > 0 ? serializeMemoryFile(file.lines).trimEnd() : "(empty)",
			].join("\n"),
		)
		.join("\n\n");
}

/**
 * One call to the `small` model with its own deadline, which also bounds its background retry of a rate limit or
 * transient failure; the spend goes on the session's cost.
 */
export async function askSmallModel(
	api: Pick<FeatureSetup, "usage">,
	ctx: FeatureContext,
	small: SmallModel,
	request: { kind: string; prompt: string; maxTokens: number; timeoutMs: number; signal?: AbortSignal },
): Promise<{ text: string; model: string } | { error: string }> {
	const deadline = AbortSignal.timeout(request.timeoutMs);
	const reply = await small.call(ctx, {
		text: request.prompt,
		signal: request.signal ? AbortSignal.any([request.signal, deadline]) : deadline,
		maxTokens: request.maxTokens,
		retry: BACKGROUND_RETRY,
	});
	if ("error" in reply) return reply;
	api.usage.record(request.kind, reply.provider, reply.modelId, reply.usage);
	return { text: reply.text, model: reply.model };
}

/** A reply's JSON object: bare, or inside one fenced block. */
function replyObject(text: string): unknown {
	const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
	return JSON.parse(fenced ? fenced[1] : text.trim());
}

/**
 * A reply as ops per file: `{"workspace": [...], "global": [...]}` with keys only for `scopes` and at most `maxOps` ops
 * in all. Throws, naming the problem, on anything else; nothing is applied then.
 */
export function parseOpsReply(
	text: string,
	scopes: readonly MemoryFileScope[],
	maxOps: number,
	/** Keys a pass reads itself (not files), which are left out of the ops. */
	otherKeys: readonly string[] = [],
): Map<MemoryFileScope, MemoryOp[]> {
	let value: unknown;
	try {
		value = replyObject(text);
	} catch (error) {
		throw new Error(`the reply is not JSON (${errorMessage(error)})`, { cause: error });
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("the reply is not a JSON object of ops per file");
	const out = new Map<MemoryFileScope, MemoryOp[]>();
	for (const [key, ops] of Object.entries(value)) {
		if (otherKeys.includes(key)) continue;
		const scope = scopes.find((each) => each === key);
		if (!scope) throw new Error(`the reply names "${key}", which is not a file under review`);
		out.set(scope, parseMemoryOps(ops));
	}
	const count = [...out.values()].reduce((sum, ops) => sum + ops.length, 0);
	if (count > maxOps) throw new Error(`the reply has ${count} ops, over the ${maxOps} allowed`);
	return out;
}

/** The reply's `defects` key, which `parseOpsReply` leaves out (see `defects.ts`); undefined without one. Call after `parseOpsReply` accepted the text. */
export function replyDefect(text: string): Defect | undefined {
	return parseDefects((replyObject(text) as Record<string, unknown>).defects);
}

/** `op` as a background pass applies it: invisible characters gone, marked as the reflection's, never pinned. */
export function passOp(op: MemoryOp): MemoryOp {
	if (op.op === "evict" || op.op === "flag") return op;
	const text = storedText(op.text).replace(/\s+/g, " ");
	if (op.op === "add") return { op: "add", section: op.section, text, source: "reflection" };
	return { ...op, text, source: "reflection" };
}

/** What one pass did to one file, as the session entry records it. */
export interface PassFileOutcome {
	scope: MemoryFileScope;
	path: string;
	changed: boolean;
	diff: string;
	evicted: string[];
	flagged: Array<{ text: string; reason: string }>;
	skipped: string[];
	/** Texts held back as quarantined candidates, with why. */
	quarantined: Array<{ text: string; reason: string }>;
	/** Why the file was left unchanged (a refused change, a tracked file's proposed diff). */
	refused?: string;
	/** On a change: lines whose text is new, lines whose text is gone, and merge ops applied. */
	added?: number;
	removed?: number;
	merged?: number;
}

/** Lines of `after` whose text `before` lacks, and the other way round (a rewrite is one of each). */
function lineChanges(before: readonly MemoryLine[], after: readonly MemoryLine[]): { added: number; removed: number } {
	const count = (lines: readonly MemoryLine[]) => {
		const keys = new Map<string, number>();
		for (const line of lines) keys.set(memoryLineKey(line.text), (keys.get(memoryLineKey(line.text)) ?? 0) + 1);
		return keys;
	};
	const was = count(before);
	const now = count(after);
	const missing = (from: Map<string, number>, to: Map<string, number>) =>
		[...from].reduce((sum, [key, n]) => sum + Math.max(0, n - (to.get(key) ?? 0)), 0);
	return { added: missing(now, was), removed: missing(was, now) };
}

interface HeldBack {
	text: string;
	section: MemorySection;
	reason: string;
}

/**
 * Applies `ops` to `file`: a text `quarantine` refuses is held back (returned, for the caller to queue as a quarantined
 * candidate), the rest go through the writer, and evicted lines are kept in the database. A refused change leaves the
 * file as it was and is reported.
 */
export async function applyPassOps(
	deps: {
		store: MemoryStore;
		repeats: ((text: string) => string | undefined) | undefined;
		env: NodeJS.ProcessEnv;
		now?: Date | number;
		signal?: AbortSignal;
	},
	file: MemoryFileRef,
	ops: readonly MemoryOp[],
	quarantine: (text: string) => string | undefined,
): Promise<{ outcome: PassFileOutcome; held: HeldBack[] }> {
	const held: HeldBack[] = [];
	const unfit: string[] = [];
	const kept = ops.filter((op) => {
		if (op.op === "evict" || op.op === "flag") return true;
		// One line the writer would refuse (too long, a secret) must not cost the pass its other ops.
		const problem = lineProblem({
			section: "Reflections",
			pinned: false,
			text: op.text,
			source: "reflection",
			date: "2000-01-01",
		});
		if (problem) unfit.push(`${op.text.slice(0, 80)}: ${problem}`);
		const reason = problem ? undefined : quarantine(op.text);
		if (reason) held.push({ text: op.text, section: op.section ?? "Reflections", reason });
		return !problem && !reason;
	});
	const outcome: PassFileOutcome = {
		scope: file.scope,
		path: file.path,
		changed: false,
		diff: "",
		evicted: [],
		flagged: [],
		skipped: unfit,
		quarantined: held.map(({ text, reason }) => ({ text, reason })),
	};
	if (kept.length === 0) return { outcome, held };
	try {
		// Evicted lines go to the database before the file loses them.
		let archived: string[] = [];
		const update = await updateMemoryFile(
			file,
			kept,
			{
				...(deps.now !== undefined ? { now: deps.now } : {}),
				...(deps.repeats ? { repeats: deps.repeats } : {}),
				...(deps.signal ? { signal: deps.signal } : {}),
				beforeWrite: async (planned) => {
					archived = await archive(deps.store, file, planned.evicted);
				},
			},
			deps.env,
		);
		// Lines the pass wrote get notes, so the file holds nothing the database cannot reach.
		if (update.changed) adoptFileLines(deps.store, file, update.lines);
		const skippedOps = new Set(update.skipped.map(({ op }) => op));
		Object.assign(outcome, {
			changed: update.changed,
			diff: update.diff,
			...(update.changed
				? {
						...lineChanges(parseMemoryFile(update.before).lines, update.lines),
						merged: kept.filter((op) => op.op === "merge" && !skippedOps.has(op)).length,
					}
				: {}),
			evicted: update.changed ? archived : [],
			flagged: update.flagged.map(({ line, reason }) => ({ text: line.text, reason })),
			skipped: [
				...unfit,
				...update.skipped.map(({ op, reason }) => `${"text" in op ? op.text : op.target}: ${reason}`),
			],
		});
	} catch (error) {
		if (!(error instanceof MemoryFileError)) throw error;
		outcome.refused = error instanceof MemoryFileTrackedError ? "tracked by git; change proposed" : error.message;
		if (error instanceof MemoryFileTrackedError) outcome.diff = error.diff;
	}
	return { outcome, held };
}

/** One line for the user about what a pass did, or undefined when it did nothing worth saying. */
function passSummary(
	pass: string,
	outcomes: readonly PassFileOutcome[],
	proposed: readonly string[],
): string | undefined {
	const parts = outcomes.flatMap((outcome) => {
		const said: string[] = [];
		if (outcome.changed) {
			const merged = outcome.merged ? `, ${outcome.merged} merged` : "";
			said.push(`${LABEL[outcome.scope]} +${outcome.added ?? 0} −${outcome.removed ?? 0} lines${merged}`);
		}
		if (outcome.refused) said.push(`${LABEL[outcome.scope]} not written (${outcome.refused})`);
		if (outcome.quarantined.length > 0) said.push(`${outcome.quarantined.length} line(s) held back as untrusted`);
		if (outcome.flagged.length > 0) said.push(`${outcome.flagged.length} line(s) marked recheck`);
		return said;
	});
	if (proposed.length > 0) parts.push(`proposed ${proposed.join(", ")} on the backlog`);
	return parts.length > 0 ? `Memory ${pass}: ${parts.join("; ")}.` : undefined;
}

/**
 * Records a pass in the session, with the line it says (`text`), so a later look (the web view, `/memory`) shows what
 * the user was told. In a session with a screen it says that line; when the pass changed a file it also announces a
 * `memory_update` notice (the Notification hooks).
 */
export function recordPass(
	api: Pick<FeatureSetup, "session" | "channels">,
	ctx: Pick<FeatureContext, "hasUI" | "ui">,
	record: {
		pass: string;
		trigger: string;
		model?: string;
		files: PassFileOutcome[];
		/** Why the pass changed nothing: a failed call, a refused reply. */
		error?: string;
		signals?: unknown;
		/** Files left out because they hold content to fix by hand. */
		unreadable?: string[];
		/** Backlog items the pass proposed for a defect it found (`defects.ts`). */
		proposed?: string[];
	},
): void {
	const summary = record.error
		? `Memory ${record.pass}: ${record.error}; files unchanged.`
		: passSummary(record.pass, record.files, record.proposed ?? []);
	api.session.appendEntry(MEMORY_PASS_TYPE, { ...record, ...(summary ? { text: summary } : {}) });
	if (!summary) return;
	if (ctx.hasUI) notify(ctx.ui, summary, record.error ? "warning" : "info");
	if (!record.error && record.files.some((file) => file.changed))
		publishUserNotice(api.channels, { type: "memory_update", title: "Octocode: memory updated", message: summary });
}
