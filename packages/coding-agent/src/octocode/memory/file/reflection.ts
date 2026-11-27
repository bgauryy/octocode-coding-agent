import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { clipText } from "../../shared/util.ts";
import type { MemoryStore } from "../store.ts";
import { isQuarantined } from "./candidate-tags.ts";
import { type Defect, proposeDefect, taggedLine } from "./defects.ts";
import { listCandidates, pendingCandidates, queueCandidates } from "./candidates.ts";
import { MEMORY_LINE_MAX_CHARS } from "./format.ts";
import {
	applyPassOps,
	askSmallModel,
	filesBlock,
	type PassFileOutcome,
	parseOpsReply,
	passOp,
	readPassFiles,
	recordPass,
	replyDefect,
	type SmallModel,
} from "./passes.ts";
import type { MemoryFileRef } from "../../permission/memory-files.ts";
import { savedKeys, splitCandidates } from "./prefilter.ts";
import { quarantineReason, type Taint } from "./quarantine.ts";
import type { SessionSignal } from "./signals.ts";

/**
 * The reflection pass at the end of a main session that had an outside signal (`signals.ts`): one `small` model call
 * sees the last checkpoint, the session's candidates, the signals with the entries that show them, and both MEMORY.md
 * files, and proposes at most three ops. Code applies them as the reflection's, never pinned, with quarantined text
 * held back (`quarantine.ts`); a tool or harness defect it names is filed as a proposed backlog item (`defects.ts`); a reply that is not the JSON asked for leaves both files unchanged.
 */

const MAX_OPS = 3;
const MAX_TOKENS = 1200;
const CHECKPOINT_CHARS = 6000;
const CANDIDATES_SHOWN = 20;

interface ReflectionInput {
	session: string;
	entries: readonly SessionEntry[];
	signals: readonly SessionSignal[];
	files: readonly MemoryFileRef[];
}

interface ReflectionDeps {
	api: Pick<FeatureSetup, "session" | "usage" | "channels">;
	store: MemoryStore;
	repeats: ((text: string) => string | undefined) | undefined;
	env: NodeJS.ProcessEnv;
	small: SmallModel;
	taint: Taint;
	timeoutMs: number;
	now?: () => number;
}

/** The newest compaction summary of the branch, cut to what a small model reads; "(no compaction)" without one. */
function lastCheckpoint(entries: readonly SessionEntry[]): string {
	const entry = entries.findLast((each) => each.type === "compaction");
	return entry?.type === "compaction" ? clipText(entry.summary.trim(), CHECKPOINT_CHARS) : "(no compaction)";
}

const signalLine = (session: string, signal: SessionSignal): string =>
	`- ${signal.kind} (session ${session}, ${signal.entries.length === 1 ? "entry" : "entries"} ${signal.entries.join(", ")}): ${signal.evidence}`;

/** Runs the pass; the session entry it records says what changed. */
export async function reflectOnSession(
	ctx: FeatureContext,
	deps: ReflectionDeps,
	input: ReflectionInput,
): Promise<void> {
	const { files, unreadable } = await readPassFiles(input.files, deps.env);
	if (files.length === 0) return;
	const all = listCandidates(deps.store);
	// A candidate a saved lesson already says is no news to the model; the signals still are, so the call stays.
	const { remaining: mine } = splitCandidates(
		pendingCandidates(all).filter((memory) => memory.sourceSession === input.session),
		savedKeys(files),
	);
	mine.splice(CANDIDATES_SHOWN);
	const now = deps.now?.() ?? Date.now();
	const prompt = renderPrompt("workflows/memory/reflect.md", {
		maxOps: MAX_OPS,
		maxChars: MEMORY_LINE_MAX_CHARS,
		date: new Date(now).toISOString().slice(0, 10),
		scopes: files.map((file) => `"${file.ref.scope}"`).join(", "),
		files: filesBlock(files),
		signals: input.signals.map((signal) => signalLine(input.session, signal)).join("\n"),
		candidates:
			mine.length > 0 ? mine.map((memory) => `- [${memory.kind}] ${clipText(memory.title, 300)}`).join("\n") : "(none)",
		checkpoint: lastCheckpoint(input.entries),
	});
	const signals = input.signals.map((signal) => ({ kind: signal.kind, entries: signal.entries }));
	const reply = await askSmallModel(deps.api, ctx, deps.small, {
		kind: "memory_reflection",
		prompt,
		maxTokens: MAX_TOKENS,
		timeoutMs: deps.timeoutMs,
	});
	if ("error" in reply) {
		recordPass(deps.api, ctx, {
			pass: "reflection",
			trigger: "end",
			files: [],
			signals,
			error: `the model call failed (${reply.error})`,
		});
		return;
	}
	let planned: ReturnType<typeof parseOpsReply>;
	let defect: Defect | undefined;
	try {
		planned = parseOpsReply(
			reply.text,
			files.map((file) => file.ref.scope),
			MAX_OPS,
			["defects"],
		);
		defect = replyDefect(reply.text);
	} catch (problem) {
		recordPass(deps.api, ctx, {
			pass: "reflection",
			trigger: "end",
			model: reply.model,
			files: [],
			signals,
			error: `the model's reply was refused (${(problem as Error).message})`,
		});
		return;
	}
	const quarantined = all.filter(isQuarantined).map((memory) => memory.title);
	const outcomes: PassFileOutcome[] = [];
	const proposed: string[] = [];
	if (defect) {
		const filed = proposeDefect(deps.store, defect, { session: input.session, env: deps.env });
		if (filed && "refused" in filed) proposed.push(`nothing (${filed.refused})`);
		else if (filed) {
			proposed.push(`${filed.ref} (${defect.title})`);
			const line = taggedLine(defect, filed.ref);
			// The workaround waits in the workspace file until the item is done.
			if (line && files.some((file) => file.ref.scope === "workspace"))
				planned.set("workspace", [
					...(planned.get("workspace") ?? []),
					{ op: "add", section: "Gotchas", text: line, source: "reflection" },
				]);
		}
	}
	for (const file of files) {
		const ops = (planned.get(file.ref.scope) ?? []).map(passOp);
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
				evidence: `session ${input.session}, reflection`,
				quarantine: item.reason,
			})),
			input.session,
		);
		outcomes.push(outcome);
	}
	recordPass(deps.api, ctx, {
		pass: "reflection",
		trigger: "end",
		model: reply.model,
		files: outcomes,
		signals,
		...(unreadable.length > 0 ? { unreadable } : {}),
		...(proposed.length > 0 ? { proposed } : {}),
	});
}
