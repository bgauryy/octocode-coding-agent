import fs from "node:fs";
import path from "node:path";
import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { sharedAgentDb } from "../../../storage/database.ts";
import { clipText } from "../../shared/util.ts";
import { normalizeTitle } from "../query.ts";
import type { Memory } from "../record.ts";
import type { MemoryStore } from "../store.ts";
import { dropCandidates, listCandidates, pendingCandidates, queueCandidates } from "./candidates.ts";
import { isQuarantined } from "./candidate-tags.ts";
import type { MemoryOp } from "./consolidate.ts";
import { lineCap, MEMORY_LINE_MAX_CHARS, memoryLineKey } from "./format.ts";
import { claimConsolidation, type ConsolidationClaim } from "./lease.ts";
import {
	applyPassOps,
	askSmallModel,
	filesBlock,
	type PassFile,
	type PassFileOutcome,
	parseOpsReply,
	passOp,
	readPassFiles,
	recordPass,
	type SmallModel,
} from "./passes.ts";
import { globalMemoryFile, type MemoryFileRef, workspaceMemoryFile } from "../../permission/memory-files.ts";
import { savedKeys, splitCandidates } from "./prefilter.ts";
import { quarantineReason, type Taint } from "./quarantine.ts";

/**
 * The consolidation pass: at most once a day per MEMORY.md (`lease.ts`), when lesson candidates are pending. Code first
 * evicts what repeats AGENTS.md or shipped policy (a line you wrote is marked `recheck` instead), marks a line that names
 * a repository path that is gone, and confirms a line a candidate restates. Then, with a `small` model and
 * `memory.reflection` on, the model merges duplicates and paraphrases, marks both sides of a contradiction, and adds the
 * candidates that are durable rules; the candidates it saw are dropped. Without a model only the code's part runs. The
 * writer evicts by rank when a file is over its cap either way.
 */

const MAX_OPS = 20;
const MAX_CANDIDATES = 40;
const MAX_TOKENS = 3000;

interface ConsolidationDeps {
	api: Pick<FeatureSetup, "session" | "usage" | "channels">;
	store: MemoryStore;
	repeats: ((text: string) => string | undefined) | undefined;
	env: NodeJS.ProcessEnv;
	/** The model, or undefined to run only the code's part. */
	small: SmallModel | undefined;
	taint: Taint;
	timeoutMs: number;
	signal?: AbortSignal;
	now?: () => number;
}

/** A repository path a line names, as `packages/db/src/db.ts`: a relative path of two parts or more, no glob or placeholder. */
const REPO_PATH = /(?<![\w/.:@~-])((?:\.\/)?[\w.@-]+(?:\/[\w.@-]+)+\/?)(?![\w/*{<.@-])/g;

/** The first path `text` names under `root` that no longer exists; a path whose first part is not in `root` is not judged. */
function brokenAnchor(text: string, root: string): string | undefined {
	for (const match of text.matchAll(REPO_PATH)) {
		const named = match[1].replace(/^\.\//, "");
		const first = named.split("/")[0];
		if (!first || first === "." || first === ".." || !fs.existsSync(path.join(root, first))) continue;
		if (!fs.existsSync(path.join(root, named))) return named;
	}
	return undefined;
}

/** The ops code proposes for `file`: repeats evicted or marked, gone paths marked, restated lines confirmed. */
function codeOps(
	file: PassFile,
	candidates: readonly Memory[],
	repeats: ((text: string) => string | undefined) | undefined,
): MemoryOp[] {
	const ops: MemoryOp[] = [];
	const restated = new Set(candidates.map((memory) => normalizeTitle(memory.title)));
	for (const line of file.lines) {
		const repeat = repeats?.(line.text);
		if (repeat && line.source !== "user") {
			ops.push({ op: "evict", target: line.text, reason: `repeats ${repeat}` });
			continue;
		}
		if (repeat) ops.push({ op: "flag", target: line.text, reason: `repeats ${repeat}` });
		const gone = file.ref.scope === "workspace" ? brokenAnchor(line.text, file.ref.root) : undefined;
		if (gone) ops.push({ op: "flag", target: line.text, reason: `names ${gone}, which no longer exists` });
		// A candidate that says the same as a line confirms it: the date moves on, the higher source stays.
		if (restated.has(memoryLineKey(line.text)))
			ops.push({ op: "add", section: line.section, text: line.text, source: "agent" });
	}
	return ops;
}

const candidateLine = (memory: Memory): string =>
	`- [${memory.kind}] ${clipText(memory.title.replace(/\s+/g, " "), 300)} (${memory.keywords.split(/\s+/).at(-1) ?? "checkpoint"}, session ${memory.sourceSession ?? "unknown"})`;

/** The prompt of a model pass over `files` and `candidates`. */
function consolidationPrompt(files: readonly PassFile[], candidates: readonly Memory[], date: string): string {
	return renderPrompt("workflows/memory/consolidate.md", {
		maxOps: MAX_OPS,
		maxLines: lineCap(),
		maxChars: MEMORY_LINE_MAX_CHARS,
		date,
		scopes: files.map((file) => `"${file.ref.scope}"`).join(", "),
		files: filesBlock(files),
		candidates: candidates.length > 0 ? candidates.map(candidateLine).join("\n") : "(none)",
	});
}

/** Takes the pass of each file that is due; the claims taken are returned for release. */
function claimDue(
	deps: ConsolidationDeps,
	refs: readonly MemoryFileRef[],
): Array<{ ref: MemoryFileRef; claim: ConsolidationClaim & { ok: true } }> {
	const workspaceId = deps.store.workspaceId;
	if (!workspaceId) return [];
	const agentDb = sharedAgentDb(deps.env);
	const now = deps.now?.() ?? Date.now();
	return refs.flatMap((ref) => {
		const claim = claimConsolidation(agentDb, workspaceId, ref, now);
		return claim.ok ? [{ ref, claim }] : [];
	});
}

/**
 * Runs the pass for the files of `ctx`'s session that are due, when candidates are pending; whether any file was due.
 * A model call that fails, or a reply that is not the JSON asked for, leaves the files and the candidates as they were;
 * only a failed call (nothing spent) leaves the pass unrecorded, so the next trigger tries again.
 */
export async function consolidateDue(
	ctx: FeatureContext,
	deps: ConsolidationDeps,
	trigger: "start" | "end",
): Promise<boolean> {
	const all = listCandidates(deps.store);
	const pending = pendingCandidates(all);
	if (pending.length === 0) return false;
	const claims = claimDue(deps, [globalMemoryFile(deps.env), workspaceMemoryFile(ctx.cwd)]);
	if (claims.length === 0) return false;
	let finished = false;
	try {
		const { files, unreadable } = await readPassFiles(
			claims.map(({ ref }) => ref),
			deps.env,
		);
		const now = deps.now?.() ?? Date.now();
		const shown = pending.slice(0, MAX_CANDIDATES);
		const modelOps = new Map<string, MemoryOp[]>();
		// Code settles candidates a saved line, AGENTS.md or an earlier candidate covers; the model sees only the rest.
		const { remaining, resolved } = splitCandidates(shown, savedKeys(files), deps.repeats);
		let model: string | undefined;
		if (deps.small && files.length > 0 && remaining.length > 0) {
			const reply = await askSmallModel(deps.api, ctx, deps.small, {
				kind: "memory_consolidation",
				prompt: consolidationPrompt(files, remaining, new Date(now).toISOString().slice(0, 10)),
				maxTokens: MAX_TOKENS,
				timeoutMs: deps.timeoutMs,
				...(deps.signal ? { signal: deps.signal } : {}),
			});
			const failure = (error: string) =>
				recordPass(deps.api, ctx, { pass: "consolidation", trigger, files: [], error });
			if ("error" in reply) {
				// A pass the session's end stopped is taken over by the end's own pass: nothing to record.
				if (!deps.signal?.aborted) failure(`the model call failed (${reply.error})`);
				return true;
			}
			model = reply.model;
			try {
				const scopes = files.map((file) => file.ref.scope);
				for (const [scope, ops] of parseOpsReply(reply.text, scopes, MAX_OPS)) modelOps.set(scope, ops.map(passOp));
			} catch (problem) {
				// The reply was paid for: the pass counts as done for today.
				finished = true;
				failure(`the model's reply was refused (${(problem as Error).message})`);
				return true;
			}
		}
		const quarantined = all.filter(isQuarantined).map((memory) => memory.title);
		const outcomes: PassFileOutcome[] = [];
		for (const file of files) {
			const ops = [...codeOps(file, pending, deps.repeats), ...(modelOps.get(file.ref.scope) ?? [])];
			if (ops.length === 0) continue;
			const { outcome, held } = await applyPassOps(
				{ store: deps.store, repeats: deps.repeats, env: deps.env, now },
				file.ref,
				ops,
				(text) => quarantineReason(text, deps.taint, quarantined),
			);
			queueCandidates(
				deps.store,
				held.map((item) => ({
					text: item.text,
					kind: "fact",
					origin: "reflection",
					evidence: `consolidation of the ${file.ref.scope} MEMORY.md`,
					quarantine: item.reason,
				})),
				ctx.sessionManager.getSessionId(),
			);
			outcomes.push(outcome);
		}
		// The model saw `remaining` and kept what it wanted; without a call only the candidates code settled did their work.
		const used = model ? shown : resolved;
		dropCandidates(
			deps.store,
			used.map((memory) => memory.id),
		);
		recordPass(deps.api, ctx, {
			pass: "consolidation",
			trigger,
			...(model ? { model } : {}),
			files: outcomes,
			...(unreadable.length > 0 ? { unreadable } : {}),
		});
		finished = true;
		return true;
	} finally {
		for (const { claim } of claims) claim.release(finished);
	}
}
