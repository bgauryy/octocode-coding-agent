import { isItemType, ITEM_TYPES } from "@octocodeai/octocode-contracts/backlogs";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { timedTool } from "../render/rows.ts";
import { withReason } from "../shared/reason.ts";
import { type Backlog, type BacklogOptions, openBacklogWhenReady } from "./context.ts";
import {
	ADD_ENTRY_FIELDS,
	EDIT_ENTRY_FIELDS,
	entryAccepted,
	ITEM_FIELDS,
	type PLAN_OPS,
	planAccepted,
	planParameters,
	WORK_FIELDS,
} from "./plan-schema.ts";
import { parseJsonStrings } from "./tool-arguments.ts";
import { batchAdd, batchUpdate, refuseUnknown } from "./tool-batch.ts";
import { filterFor, legacyListFields, type ListArguments, listFields, listParams, runList } from "./tool-list.ts";
import { backlogRenderers } from "./tool-render.ts";
import { type RunParams, runBacklog } from "./tool-run.ts";
import { checkedEntry, type LinkArgument, linkInput } from "./tool-schema.ts";
import { oneWrite } from "./tool-support.ts";
import { BacklogBatchAbortedError } from "./batch-outcome.ts";
import { backlogPlanPrompt } from "./tool-text.ts";

type Write = "add" | "edit";
/** One `items` entry: the fields of a single add or edit. */
type Entry = Omit<RunParams, "op" | "links" | "limit" | "offset" | "changes"> & { links?: LinkArgument[] };
type Params = ListArguments & { op: (typeof PLAN_OPS)[number]; items?: Array<Record<string, unknown>> };

const LIST_FILTERS = Object.keys(listFields);
const ALL_FILTERS = [...LIST_FILTERS, ...Object.keys(legacyListFields)];
/** A work field in an entry reaches `write`, which names the `backlog` operation that takes it. */
const WORK = Object.keys(WORK_FIELDS);
const ENTRY_FIELDS: Record<Write, readonly string[]> = {
	add: [...ADD_ENTRY_FIELDS, ...WORK],
	edit: [...EDIT_ENTRY_FIELDS, ...WORK],
};
/** The fields a refusal names: the declared ones (the `backlog` fields are answered, not offered). */
const SHOWN: Record<Write, readonly string[]> = { add: ADD_ENTRY_FIELDS, edit: EDIT_ENTRY_FIELDS };
const EXAMPLE: Record<Write, string> = { add: "{title, goal, why}", edit: "{id, priority}" };

/**
 * `backlogPlan`: planning and triage. `add` proposes items, `edit` changes their fields, `list` finds them. A session
 * works an item far more often than it plans, so `backlog` carries the work operations and this tool the rest; a
 * subagent registers it without declaring it (it reports follow-ups, its coordinator files them).
 */
export function registerBacklogPlanTool(
	api: ExtensionAPI,
	options: BacklogOptions & { changed?: (ctx: ExtensionContext) => void },
): void {
	const subagent = options.isSubagent;
	const { ops, ...prompt } = backlogPlanPrompt();
	const parameters = planParameters(ops);
	const accepted = planAccepted(parameters);
	api.registerTool(
		timedTool({
			name: "backlogPlan",
			roleVariant: true,
			label: "Backlog plan",
			...prompt,
			defaultActive: !subagent,
			parameters,
			validationParameters: withReason(accepted),
			// A `list` runs beside other reads; a write runs alone in its message and after every earlier write.
			concurrency: (args) => (args.op === "list" ? "shared" : "exclusive"),
			async execute(_id, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				// `reason` is every native call's purpose (`shared/reason.ts`), never the item's why.
				const { reason: _reason, ...args } = parseJsonStrings(params as Params & { reason?: string });
				const given = Object.entries(args)
					.filter(([key, value]) => key !== "op" && value !== undefined)
					.map(([key]) => key);
				if (args.op === "list") return list(await openBacklogWhenReady(ctx, options, signal), args, given);
				const op = args.op;
				let result;
				try {
					result = await oneWrite(async () => {
						signal?.throwIfAborted();
						return written(await openBacklogWhenReady(ctx, options, signal), args, op, given, signal);
					});
				} catch (error) {
					if (
						error instanceof BacklogBatchAbortedError &&
						(error.result.details.applied || error.result.details.uncertain)
					) {
						// A view notification must not erase the durable partial-write receipt.
						try {
							options.changed?.(ctx);
						} catch {
							// The write receipt remains authoritative if its view observer fails.
						}
					}
					throw error;
				}
				options.changed?.(ctx);
				return result;
			},
			...backlogRenderers("Backlog plan"),
		}),
	);

	/** `list`: its own filters only, so an item field sent as a filter is answered with the filter that reads it. */
	function list(backlog: Backlog, args: Params, given: readonly string[]) {
		const other = given.filter((key) => !ALL_FILTERS.includes(key));
		if (other.length) {
			const instead = other.map((key) => filterFor(key)).filter(Boolean);
			throw new Error(
				`list does not take ${other.join(", ")}: ${instead.length ? `use ${instead.join(", ")}` : `its filters are ${LIST_FILTERS.join(", ")}`}.`,
			);
		}
		const { op: _op, items: _items, ...filters } = args;
		return runList(backlog, listParams(filters));
	}

	/**
	 * `add` or `edit`: each entry of `items` is one store write with every store check. One entry answers as that
	 * write does; several answer with a line each, and a refused one does not stop the rest.
	 */
	async function written(backlog: Backlog, args: Params, op: Write, given: readonly string[], signal?: AbortSignal) {
		const beside = given.filter((key) => key !== "items");
		const filters = beside.filter((key) => ALL_FILTERS.includes(key));
		if (filters.length) throw new Error(`${op} does not take ${filters.join(", ")}: list filters.`);
		const unknown = beside.filter((key) => !ITEM_FIELDS.includes(key) && !(key in WORK_FIELDS) && key !== "links");
		const misplaced = beside.filter((key) => !ENTRY_FIELDS[op].includes(key));
		if (unknown.length || misplaced.length)
			throw new Error(
				`Unknown backlogPlan fields: ${[...new Set([...unknown, ...misplaced])].join(", ")}. ${op} takes items, one entry per item: ${SHOWN[op].join(", ")}.`,
			);
		// Item fields belong in an entry. A call that writes them beside `items` (a shape models send) is read as
		// meant: they are every entry's defaults, and without `items` they are the one entry.
		const defaults = Object.fromEntries(beside.map((key) => [key, (args as Record<string, unknown>)[key]]));
		const own = op === "add" ? "title" : "id";
		if (args.items !== undefined && defaults[own] !== undefined)
			throw new Error(`${op} with items takes no ${own} beside them: each entry carries its own ${own}.`);
		const items = args.items ?? (beside.length ? [{}] : []);
		if (!Array.isArray(items) || items.length === 0)
			throw new Error(`${op} needs items, one entry per item: items [${EXAMPLE[op]}].`);
		const allowed = ENTRY_FIELDS[op];
		const entry = (fields: Record<string, unknown>) =>
			checkedEntry(entryAccepted, parseJsonStrings({ ...defaults, ...fields })) as Entry;
		if (items.length === 1) {
			refuseUnknown(items[0], allowed, "items", SHOWN[op]);
			return backlog.store.transactionWhenReady(() => write(backlog, op, entry(items[0])), signal);
		}
		return op === "add"
			? batchAdd(
					items,
					allowed,
					"items",
					(fields, earlier) =>
						backlog.store.transactionWhenReady(() => write(backlog, op, earlier(entry(fields))), signal),
					SHOWN[op],
					signal,
				)
			: batchUpdate(
					items,
					allowed,
					"items",
					(fields) => backlog.store.transactionWhenReady(() => write(backlog, op, entry(fields)), signal),
					SHOWN[op],
					signal,
				);
	}

	/** One entry as the store write it is; the fields `backlog` owns are refused with its operation. */
	function write(backlog: Backlog, op: Write, entry: Entry) {
		const work = Object.keys(entry).filter((key) => key in WORK_FIELDS);
		if (work.length)
			throw new Error(
				`backlogPlan does not take ${work.join(", ")}: use backlog with op ${work.map((key) => WORK_FIELDS[key]).join(", ")}.`,
			);
		if (entry.state === "done")
			throw new Error("backlogPlan does not finish an item: use backlog with op done and its completion.");
		if (entry.type !== undefined && !isItemType(entry.type))
			throw new Error(`Unknown item type ${visibleControls(entry.type)}: use ${ITEM_TYPES.join(", ")}.`);
		const { links, ...fields } = entry;
		return runBacklog(
			backlog,
			{
				...fields,
				...(links !== undefined ? { links: linkInput(links, backlog.store.repo) } : {}),
				op: op === "add" ? "add" : "update",
			},
			{ subagent, word: op },
		);
	}
}
