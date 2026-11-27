import { StringEnum } from "@octocodeai/octocode-ai";
import { BACKLOG_ITEM_ENV } from "@octocodeai/octocode-common/env";
import type { CloseInput } from "@octocodeai/octocode-contracts/backlogs";
import { Type } from "typebox";
import type { FeatureSetup, FeatureContext, ToolDefinition } from "../../../../core/features/index.ts";
import { timedTool } from "../../../render/rows.ts";
import { withReason } from "../../../shared/reason.ts";
import { type Backlog, type BacklogOptions, openBacklogWhenReady } from "../../../backlog/context.ts";
import { parseJsonStrings, splitIds } from "../../../backlog/tool-arguments.ts";
import { batchGet, batchUpdate } from "../../../backlog/tool-batch.ts";
import { backlogRenderers } from "../../../backlog/tool-render.ts";
import { endedSignal } from "../../../backlog/ended-signal.ts";
import { runBacklog } from "../../../backlog/tool-run.ts";
import { AUDIT_SHOWN } from "../../../backlog/audit-text.ts";
import { type CompletionGate, completionInfo } from "../../../backlog/completion-gate.ts";
import { doneRefusal, type Holdings } from "../../../backlog/done-guard.ts";
import { dropBaseline, recordBaseline } from "../../../backlog/qa-baseline.ts";
import { reviewBeforeDone } from "../../../backlog/qa-run.ts";
import { startReviews } from "../../../backlog/qa-prefetch.ts";
import { announceDone } from "../../../backlog/done-signal.ts";
import { doneReply } from "../../../backlog/done-reply.ts";
import type { QaReview, QaReviewer } from "../../../backlog/qa-gate.ts";
import { completeStep } from "../../../backlog/tool-step.ts";
import { SETTINGS_DEFAULTS } from "../../../../core/settings-defaults.ts";
import { closeField, completionField, undeclaredEntityFields } from "../../../backlog/tool-schema.ts";
import { checkMerged } from "../../../backlog/merge-gate.ts";
import { oneWrite, rehearse } from "../../../backlog/tool-support.ts";
import { backlogPrompt } from "../../../backlog/tool-text.ts";
import { signatureRates } from "./signature-rates.ts";

const OPS = ["get", "claim", "note", "done", "close", "step"] as const;
type Op = (typeof OPS)[number];
/** The operations `backlog` had before planning moved to `backlogPlan`: still validated, so the refusal names where each went. */
const MOVED_OPS = ["list", "add", "update"] as const;

/** The fields each operation takes besides `op`; a `get` also takes the paging fields its Next line prints. */
const OP_FIELDS: Record<Op, readonly string[]> = {
	get: ["id", "ids", "limit", "offset", "changes"],
	claim: ["id", "why", "goal", "note", "version"],
	note: ["id", "note", "version"],
	done: ["id", "completion", "note", "version"],
	close: ["id", "close", "note", "version"],
	step: ["id", "note", "version"],
};
const DECLARED = ["id", "note", "why", "goal", "completion", "close", "version"];
/** The head line of a batch: what it did, by operation. */
const VERBS: Record<Exclude<Op, "get">, string> = {
	claim: "Claimed",
	note: "Noted",
	done: "Done",
	close: "Closed",
	step: "Stepped",
};

/** `result` with a line of text after its own. */
const withText = <T extends { content: Array<{ type: "text"; text: string }> }>(result: T, text: string): T => ({
	...result,
	content: [{ type: "text" as const, text: `${result.content[0]?.text ?? ""}\n${text}` }],
});

/** What one entry of a batch tells `write` about its place and review: an early review, and where to report progress. */
interface EntryRun {
	started?: Promise<QaReview | undefined>;
	progress?: (text: string) => void;
	place?: { n: number; of: number };
}

interface Params {
	op: Op | (typeof MOVED_OPS)[number];
	id?: string;
	ids?: string[];
	note?: string;
	why?: string;
	goal?: string;
	completion?: Record<string, unknown>;
	close?: CloseInput;
	version?: number;
	items?: Record<string, unknown>[];
	limit?: number;
	offset?: number;
	changes?: boolean;
	state?: unknown;
}

/** A write entry's fields: the declared ones but `op` and `items`, each in its accepted form. */
function entryFields<P extends Record<string, unknown>>(properties: P) {
	const { op: _op, items: _items, ...single } = properties;
	return { ...single, version: undeclaredEntityFields.version, completion: undeclaredEntityFields.completion };
}

/** A progress line for the row while a slow step (the QA review) runs, or nothing when the caller takes no updates. */
function progressTo(onUpdate: Parameters<ToolDefinition["execute"]>[3]): ((text: string) => void) | undefined {
	return onUpdate && ((text) => onUpdate({ content: [{ type: "text", text }], details: {} }));
}

/** Where a call in the tool's old shape (`op` list, add or update) goes now, in one sentence. */
function movedCall(args: Params): string | undefined {
	if (args.op === "list") return 'backlog no longer lists items: call backlogPlan with op "list".';
	if (args.op === "add") return 'backlog no longer adds items: call backlogPlan with op "add".';
	if (args.op !== "update") return undefined;
	const op =
		args.close !== undefined
			? "close"
			: args.state === "done" || args.completion !== undefined
				? "done"
				: args.state === "ongoing"
					? "claim"
					: args.state === undefined && args.note !== undefined
						? "note"
						: undefined;
	return op
		? `backlog has no op "update": use op "${op}".`
		: 'backlog has no op "update": call backlogPlan with op "edit".';
}

/** `backlog`: the operations every task runs on the item it works on. Planning and triage are `backlogPlan`'s (`plan-tool.ts`). */
export function registerBacklogTool(
	api: FeatureSetup,
	options: BacklogOptions & {
		changed?: (ctx: FeatureContext) => void;
		completing?: CompletionGate;
		/** What this session still runs: `done` is refused while it runs or holds anything for the item. */
		holdings?: Holdings;
		/** Reviews an important item's completion before `done` writes it (`backlog.qa`); a session without it completes as the hooks allow. */
		review?: QaReviewer;
	},
): void {
	const subagent = options.isSubagent;
	const { ops, ...prompt } = backlogPrompt(subagent);
	const parameters = Type.Object(
		{
			op: StringEnum(OPS, { description: ops }),
			id: Type.Optional(Type.String({ description: "B12; get: several; step: T12" })),
			note: Type.Optional(Type.String({ description: "step: evidence" })),
			why: Type.Optional(Type.String({ description: "claim: if unset" })),
			goal: Type.Optional(Type.String({ description: "claim: checkable, if unset" })),
			completion: completionField("done: the result"),
			close: Type.Optional(closeField),
			version: Type.Optional(Type.Integer({ description: "refused if stale" })),
			items: Type.Optional(
				// Entries are checked by `accepted` below, so the declared schema stays short.
				Type.Unsafe<Record<string, unknown>[]>({
					type: "array",
					items: { type: "object" },
					description: "Batch: per-entry op fields",
				}),
			),
		},
		{ additionalProperties: false },
	);
	// What a call may carry: the declared fields, a get's paging, and anything a call in the old shape sends, which
	// `movedCall` answers with the tool and op to use instead of a schema error.
	const accepted = Type.Object(
		{
			...parameters.properties,
			op: StringEnum([...OPS, ...MOVED_OPS]),
			ids: Type.Optional(Type.Array(Type.String())),
			limit: Type.Optional(Type.Integer()),
			offset: Type.Optional(Type.Integer()),
			changes: Type.Optional(Type.Boolean()),
			version: undeclaredEntityFields.version,
			completion: undeclaredEntityFields.completion,
			// Each entry is typed as a single write; `batchUpdate` names an entry's fields its op does not take.
			items: Type.Optional(Type.Array(Type.Object(entryFields(parameters.properties)), { minItems: 1 })),
		},
		{ additionalProperties: true },
	);
	api.tools.register(
		timedTool({
			name: "backlog",
			roleVariant: true,
			label: "Backlog",
			...prompt,
			// A child declares `backlog` only when its task names the item it may update (BACKLOG_ITEM_ENV, set by the parent):
			// without one it has nothing to update and puts follow-ups in its report. Registered either way, so the store
			// rules and RPC callers are unchanged; the main session always declares it.
			defaultActive: !subagent || Boolean((options.env ?? process.env)[BACKLOG_ITEM_ENV]),
			parameters,
			validationParameters: withReason(accepted),
			// A `get` runs beside other reads; a write runs alone in its message and after every earlier write.
			concurrency: (args) => (args.op === "get" ? "shared" : "exclusive"),
			async execute(_id, params, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				// `reason` is every native call's purpose (`shared/reason.ts`), never the item's why.
				const { reason: _reason, ...args } = parseJsonStrings(params as Params & { reason?: string });
				const moved = movedCall(args);
				if (moved) throw new Error(moved);
				const op = args.op as Op;
				const given = Object.keys(args).filter((key) => key !== "op" && args[key as keyof Params] !== undefined);
				const unknown = given.filter((key) => !Object.hasOwn(accepted.properties, key));
				if (unknown.length)
					throw new Error(
						`Unknown backlog fields: ${unknown.join(", ")}: backlog takes ${DECLARED.join(", ")}; other fields change with backlogPlan op edit.`,
					);
				if (args.items !== undefined && op !== "get") {
					const other = given.filter((key) => key !== "items");
					if (other.length)
						throw new Error(`items carries each entry's fields: move ${other.join(", ")} into the entries.`);
					const entries = args.items.map((entry) => parseJsonStrings(entry));
					// Reviews of a batch's dones run ahead, a few at a time; the entries' writes below stay serial and in order.
					const ahead =
						op === "done" && options.review
							? startReviews(
									await openBacklogWhenReady(ctx, options, signal),
									entries,
									qaMode(),
									options.review,
									ctx,
									signal,
								)
							: undefined;
					try {
						return await batchUpdate(
							entries,
							OP_FIELDS[op],
							"items",
							(entry, index) =>
								write({ ...(entry as Omit<Params, "op">), op }, op, ctx, signal, {
									started: ahead?.started[index],
									progress: progressTo(onUpdate),
									place: { n: index + 1, of: entries.length },
								}),
							undefined,
							signal,
							{ operation: op, verb: VERBS[op] },
						);
					} finally {
						ahead?.stop();
						options.changed?.(ctx); // a refused or cancelled batch may still have applied entries
					}
				}
				const extra = given.filter((key) => !OP_FIELDS[op].includes(key));
				if (extra.length)
					throw new Error(
						`${op} does not take ${extra.join(", ")}: it takes ${OP_FIELDS[op].filter((key) => DECLARED.includes(key)).join(", ")}.`,
					);
				if (op === "get") {
					const backlog = await openBacklogWhenReady(ctx, options, signal);
					const { id, ids: listed, limit, offset, changes } = args;
					const ids = [...splitIds(id ?? ""), ...(listed ?? []).flatMap(splitIds)];
					const read = async (each: string | undefined) => {
						signal?.throwIfAborted();
						const audits =
							changes && each ? await backlog.store.auditAsync(each, AUDIT_SHOWN, undefined, signal) : undefined;
						signal?.throwIfAborted();
						const got = runBacklog(
							backlog,
							{ op: "get", id: each, limit, offset, changes },
							{ subagent, word: op, audits },
						);
						const item = each ? backlog.store.get(each) : undefined;
						const rates = item && (await signatureRates(item, ctx.cwd, signal));
						return rates ? withText(got, rates) : got;
					};
					return ids.length > 1 ? batchGet(ids, read, signal) : read(ids[0]);
				}
				const result = await write(args, op, ctx, signal, { progress: progressTo(onUpdate) });
				options.changed?.(ctx);
				return result;
			},
			...backlogRenderers("Backlog"),
		}),
	);

	/**
	 * One write: the done guard, git's merge check and a rehearsal of the store write (its own refusals), then the
	 * TaskCompleted hooks and the QA review, then the store write, alone in its transaction.
	 */
	async function write(
		args: Params,
		op: Exclude<Op, "get">,
		ctx: FeatureContext,
		signal?: AbortSignal,
		run: EntryRun = {},
	) {
		/** The QA note recorded with the completion, when a review ran or was skipped. */
		let qa: string | undefined;
		/** The isolated-change refs git found merged, checked before (never inside) the write's transaction. */
		let merged: readonly string[] | undefined;
		if ((op === "done" || op === "close") && args.id) {
			// The cheap checks, then the hooks and the paid review, all before the write, here, in the process that writes; a refusal leaves the item as it is.
			const backlog = await openBacklogWhenReady(ctx, options, signal);
			const item = backlog.store.get(args.id);
			if (item && item.state !== "done") {
				const held = op === "done" && options.holdings && doneRefusal(backlog.store, item, options.holdings, ctx.cwd);
				if (held) throw new Error(held);
				if (op === "done") merged = await checkMerged(backlog, item, signal);
				const checked = merged;
				await rehearse(backlog.store, () => work(backlog, args, op, checked, false), signal);
				const change = op === "done" ? "done" : "closed";
				const refusal = await options.completing?.(completionInfo(item, change, args), ctx, signal);
				if (refusal)
					throw new Error(
						`${item.ref} was not ${change === "done" ? "completed" : "closed"}: a TaskCompleted hook refused it: ${refusal}`,
					);
				if (op === "done" && options.review)
					qa = await reviewBeforeDone(backlog, item, args.completion, qaMode(), options.review, ctx, signal, {
						started: run.started,
						reviewing: () =>
							run.progress?.(`reviewing ${item.ref}${run.place ? ` (${run.place.n} of ${run.place.of})` : ""}…`),
					});
			}
		}
		// A done on an item already done changes nothing, so it is not announced (no second compaction at the boundary).
		const wasDone =
			op === "done" && args.id
				? (await openBacklogWhenReady(ctx, options, signal)).store.get(args.id)?.state === "done"
				: false;
		const written = await oneWrite(async () => {
			signal?.throwIfAborted();
			const backlog = await openBacklogWhenReady(ctx, options, signal);
			// The version was checked by the rehearsal just before the review, which can run for minutes and whose own
			// notes move it: the write follows the item as it is now, so a paid review is not wasted on a stale refusal.
			const now = qa && args.id && args.version !== undefined ? backlog.store.get(args.id)?.version : undefined;
			const given = {
				...args,
				...(qa ? { note: [args.note, qa].filter(Boolean).join("\n\n") } : {}),
				...(now === undefined ? {} : { version: now }),
			};
			return backlog.store.transactionWhenReady(() => work(backlog, given, op, merged), signal);
		});
		// The baseline QA later judges the item's own changes against: taken at the claim, dropped when the item ends.
		if (op === "claim" && args.id) await recordBaseline(ctx.cwd, args.id);
		else if ((op === "done" || op === "close") && args.id) await dropBaseline(ctx.cwd, args.id);
		if (op === "done" && args.id && args.completion !== undefined && !wasDone)
			announceDone(api, await openBacklogWhenReady(ctx, options, signal), args.id, args.completion);
		// A done tells what was finished: the summary, how it was verified and the QA outcome.
		const done = op === "done" && args.completion !== undefined;
		const finished =
			done && args.id ? (await openBacklogWhenReady(ctx, options, signal)).store.get(args.id) : undefined;
		const rates = finished && (await signatureRates(finished, ctx.cwd, signal));
		const reply = [done ? doneReply(args.completion, qa) : qa, rates].filter(Boolean).join("\n");
		return reply ? withText(written, reply) : written;
	}

	function qaMode() {
		return api.settings.get().backlog?.qa ?? SETTINGS_DEFAULTS.backlog.qa;
	}

	/**
	 * Each work operation as the store write it is: the store applies every rule (who holds the item, what a state needs).
	 * `announce` false (a rehearsal) leaves queued children unasked: the write is rolled back.
	 */
	function work(backlog: Backlog, args: Params, op: Exclude<Op, "get">, merged?: readonly string[], announce = true) {
		const run = (params: Parameters<typeof runBacklog>[1]) =>
			runBacklog(backlog, params, { subagent, word: op, merged, ...(announce ? { queued: endedSignal(api) } : {}) });
		const { id, note, version } = args;
		if (op === "step") return completeStep(backlog, { id, note, version });
		const one = { op: "update" as const, id, note, version };
		if (op === "claim") return run({ ...one, state: "ongoing", why: args.why, goal: args.goal });
		if (op === "done") return run({ ...one, state: "done", completion: args.completion as never });
		if (op === "close") {
			if (args.close === undefined)
				throw new Error("close needs close: {kind: obsolete, duplicate or wont_do, text: the reason}.");
			return run({ ...one, close: args.close });
		}
		if (!note?.trim()) throw new Error("note needs note: the progress or finding to append.");
		return run(one);
	}
}
