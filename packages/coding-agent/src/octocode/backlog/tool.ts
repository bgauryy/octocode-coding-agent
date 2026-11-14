import { StringEnum } from "@octocodeai/octocode-ai";
import type { CloseInput } from "@octocodeai/octocode-contracts/backlogs";
import { Type } from "typebox";
import { BACKLOG_ITEM_ENV } from "../../../../common/src/env.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { timedTool } from "../render/rows.ts";
import { withReason } from "../shared/reason.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { parseJsonStrings, splitIds } from "./tool-arguments.ts";
import { batchGet } from "./tool-batch.ts";
import { backlogRenderers } from "./tool-render.ts";
import { runBacklog } from "./tool-run.ts";
import { completeStep } from "./tool-step.ts";
import { closeField, completionField, legacyEntityFields } from "./tool-schema.ts";
import { oneWrite } from "./tool-support.ts";
import { backlogPrompt } from "./tool-text.ts";

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
const DECLARED = ["id", "note", "why", "goal", "completion", "close"];

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
	limit?: number;
	offset?: number;
	changes?: boolean;
	state?: unknown;
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
	api: ExtensionAPI,
	options: BacklogOptions & { changed?: (ctx: ExtensionContext) => void },
): void {
	const subagent = options.isSubagent;
	const { ops, ...prompt } = backlogPrompt(subagent);
	const parameters = Type.Object(
		{
			op: StringEnum(OPS, { description: ops }),
			id: Type.Optional(Type.String({ description: "B12; get: several; step: T12" })),
			note: Type.Optional(Type.String()),
			why: Type.Optional(Type.String({ description: "claim: why, if unset" })),
			goal: Type.Optional(Type.String({ description: "claim: checkable goal, if unset" })),
			completion: completionField("done: the result"),
			close: Type.Optional(closeField),
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
		},
		{ additionalProperties: true },
	);
	api.registerTool(
		timedTool({
			name: "backlog",
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
				const extra = given.filter((key) => !OP_FIELDS[op].includes(key));
				if (extra.length)
					throw new Error(
						`${op} does not take ${extra.join(", ")}: it takes ${OP_FIELDS[op].filter((key) => DECLARED.includes(key)).join(", ")}.`,
					);
				if (op === "get") return work(openBacklog(ctx, options), args, op);
				const result = await oneWrite(async () => {
					signal?.throwIfAborted();
					return work(openBacklog(ctx, options), args, op);
				});
				options.changed?.(ctx);
				return result;
			},
			...backlogRenderers("Backlog"),
		}),
	);

	/** Each work operation as the store write it is: the store applies every rule (who holds the item, what a state needs). */
	function work(backlog: Backlog, args: Params, op: Op) {
		const run = (params: Parameters<typeof runBacklog>[1]) => runBacklog(backlog, params, { subagent, word: op });
		const { id, note, version } = args;
		if (op === "step") return completeStep(backlog, { id, note, version });
		const one = { op: "update" as const, id, note, version };
		if (op === "get") {
			const { ids: listed, limit, offset, changes } = args;
			const page = { op: "get" as const, limit, offset, changes };
			const ids = [...splitIds(id ?? ""), ...(listed ?? []).flatMap(splitIds)];
			return ids.length > 1 ? batchGet(ids, (each) => run({ ...page, id: each })) : run({ ...page, id: ids[0] });
		}
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
