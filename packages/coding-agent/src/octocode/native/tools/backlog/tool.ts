import { StringEnum } from "@octocodeai/octocode-ai";
import { BACKLOG_ITEM_ENV } from "@octocodeai/octocode-common/env";
import type { CloseInput } from "@octocodeai/octocode-contracts/backlogs";
import { Type } from "typebox";
import type { FeatureSetup, FeatureContext } from "../../../../core/features/index.ts";
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
import type { QaReviewer } from "../../../backlog/qa-gate.ts";
import { completeStep } from "../../../backlog/tool-step.ts";
import { SETTINGS_DEFAULTS } from "../../../../core/settings-defaults.ts";
import { closeField, completionField, legacyEntityFields } from "../../../backlog/tool-schema.ts";
import { checkMerged } from "../../../backlog/merge-gate.ts";
import { oneWrite, rehearse } from "../../../backlog/tool-support.ts";
import { backlogPrompt } from "../../../backlog/tool-text.ts";

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

/** A write entry's fields: the declared ones but `op` and `items`, each in its legacy-tolerant form. */
function entryFields<P extends Record<string, unknown>>(properties: P) {
	const { op: _op, items: _items, ...single } = properties;
	return { ...single, version: legacyEntityFields.version, completion: legacyEntityFields.completion };
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
			note: Type.Optional(Type.String({ description: "step: result/check evidence" })),
			why: Type.Optional(Type.String({ description: "claim: if unset" })),
			goal: Type.Optional(Type.String({ description: "claim: checkable, if unset" })),
			completion: completionField("done: the result"),
			close: Type.Optional(closeField),
			version: Type.Optional(Type.Integer({ description: "refused if stale" })),
			items: Type.Optional(
				Type.Unsafe<Record<string, unknown>[]>({
					type: "array",
					items: { type: "object" },
					description: "batch entries",
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
			version: legacyEntityFields.version,
			completion: legacyEntityFields.completion,
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
			async execute(_id, params, signal, _onUpdate, ctx) {
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
					try {
						return await batchUpdate(
							entries,
							OP_FIELDS[op],
							"items",
							(entry) => write({ ...(entry as Omit<Params, "op">), op }, op, ctx, signal),
							undefined,
							signal,
						);
					} finally {
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
						return runBacklog(backlog, { op: "get", id: each, limit, offset, changes }, { subagent, word: op, audits });
					};
					return ids.length > 1 ? batchGet(ids, read, signal) : read(ids[0]);
				}
				const result = await write(args, op, ctx, signal);
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
	async function write(args: Params, op: Exclude<Op, "get">, ctx: FeatureContext, signal?: AbortSignal) {
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
					qa = await reviewBeforeDone(
						backlog,
						item,
						args.completion,
						api.settings.get().backlog?.qa ?? SETTINGS_DEFAULTS.backlog.qa,
						options.review,
						ctx,
						signal,
					);
			}
		}
		const written = await oneWrite(async () => {
			signal?.throwIfAborted();
			const backlog = await openBacklogWhenReady(ctx, options, signal);
			const given = qa ? { ...args, note: [args.note, qa].filter(Boolean).join("\n\n") } : args;
			return backlog.store.transactionWhenReady(() => work(backlog, given, op, merged), signal);
		});
		// The baseline QA later judges the item's own changes against: taken at the claim, dropped when the item ends.
		if (op === "claim" && args.id) await recordBaseline(ctx.cwd, args.id);
		else if ((op === "done" || op === "close") && args.id) await dropBaseline(ctx.cwd, args.id);
		return qa
			? { ...written, content: [{ type: "text" as const, text: `${written.content[0]?.text ?? ""}\n${qa}` }] }
			: written;
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
