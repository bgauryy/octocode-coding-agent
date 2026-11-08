import { StringEnum } from "@octocodeai/octocode-ai";
import type { BacklogRef, ItemType } from "@octocodeai/octocode-contracts/backlogs";
import { LIST_STATES, type ListState } from "@octocodeai/octocode-contracts/snapshot";
import path from "node:path";
import { Type } from "typebox";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { backlog as queries } from "../../../../db/src/api.ts";
import { textResult } from "../shared/util.ts";
import type { Backlog } from "./context.ts";
import { itemLine } from "./format.ts";
import type { ListQuery } from "./inputs.ts";
import { PRIORITIES } from "./store.ts";

/** A path filter entry as a repository-relative path: an absolute path inside `root` is made relative; separators and `./` are the matcher's. */
function repoRelative(entry: string, root: string): string {
	const text = entry.trim();
	if (!path.isAbsolute(text)) return text;
	const relative = path.relative(root, text);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
		? text
		: relative || ".";
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 200;
/** Rows a list without states, ids or limit shows: the open work (ongoing, todo and proposed), most important first. */
const DEFAULT_OPEN_LIMIT = 15;
const DEFAULT_LIST_STATES: ListState[] = ["ongoing", "todo", "backlog"];

/**
 * The fields only `list` reads. `list` also filters by fields other operations write (`id`, `title`, `type`,
 * `parentId`, `priority`, `tags`, `paths`, `dependsOn`, `from`); their descriptions say so beside the write meaning.
 */
export const listFields = {
	ids: Type.Optional(Type.Array(Type.String(), { description: "get/list: several item ids" })),
	since: Type.Optional(
		Type.String({ description: "list: updated (with sort created: created) since an ISO time or age (2h, 7d)" }),
	),
	sort: Type.Optional(
		StringEnum(queries.ITEM_SORTS, { description: "list: board (default), or newest updated/created first" }),
	),
};

/**
 * List filters the declaration no longer shows, still accepted so calls recorded in the old shape (a resumed session,
 * an RPC caller, a Next line printed before) validate and run: `createdSince` is `since` with sort created, and
 * `assignee` and `blocked` had no callers in recorded sessions. (`id` with several comma-separated ids also still runs.)
 */
export const legacyListFields = {
	assignee: Type.Optional(Type.String()),
	blocked: Type.Optional(Type.Boolean()),
	createdSince: Type.Optional(Type.String()),
};

/** What a list call may carry; the write fields it shares with add/update keep their declared types. */
export interface ListParams {
	states?: ListState[];
	query?: string;
	from?: string;
	/** list: one id, or (older calls) several separated by commas or spaces. */
	id?: string;
	ids?: string[];
	title?: string;
	parentId?: string | null;
	type?: ItemType;
	priority?: string;
	tags?: string[];
	paths?: string[];
	dependsOn?: Array<string | BacklogRef>;
	blocked?: boolean;
	assignee?: string;
	since?: string;
	createdSince?: string;
	sort?: queries.ItemSort;
	limit?: number;
	offset?: number;
}

const AGE = /^(\d+)\s*([mhdw])$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `since` (or `createdSince`, named by `field`) as an ISO time: an age before `now` (`2h`) or a time `Date.parse` reads. */
function sinceTime(since: string | undefined, now: number, field = "since"): string | undefined {
	if (since === undefined) return undefined;
	const age = AGE.exec(since.trim());
	const at = age ? now - Number(age[1]) * UNIT_MS[age[2]] : Date.parse(since);
	if (Number.isNaN(at))
		throw new Error(`${field} needs an ISO time or an age like 2h or 7d, not ${visibleControls(since)}.`);
	return new Date(at).toISOString();
}

/** A list argument with entries, else undefined: an empty list filters nothing, like an omitted one. */
const entries = <T>(values: readonly T[] | undefined): T[] | undefined => (values?.length ? [...values] : undefined);

/** The ids a call names: the `ids` list and `id` (older calls: comma- or space-separated). */
function givenIds(params: ListParams): string[] | undefined {
	return entries([...(params.id?.split(/[\s,]+/).filter(Boolean) ?? []), ...(params.ids ?? [])]);
}

/** The filters of a call as it may repeat them: empty lists dropped and an age made a fixed time, so Next pages the same set. */
function givenFilters(params: ListParams, now: number): Partial<ListParams> {
	if (params.parentId === null) throw new Error("list: parentId takes an item id, e.g. B3.");
	const filters: Partial<ListParams> = {
		query: params.query || undefined,
		from: params.from || undefined,
		id: givenIds(params)?.join(","),
		title: params.title?.trim() || undefined,
		parentId: params.parentId,
		type: params.type,
		priority: params.priority,
		tags: entries(params.tags),
		paths: entries(params.paths),
		dependsOn: entries(params.dependsOn),
		blocked: params.blocked,
		assignee: params.assignee?.trim() || undefined,
		since: sinceTime(params.since, now),
		createdSince: sinceTime(params.createdSince, now, "createdSince"),
		sort: params.sort,
	};
	return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

/** `list`: one page of the items every given filter matches, with a Next call that repeats the filters. */
export function runList(
	{ store, actor, session, repoRoot }: Backlog,
	params: ListParams,
	now = Date.now(),
): { content: Array<{ type: "text"; text: string }>; details: { shown: number; total: number } } {
	const filters = givenFilters(params, now);
	const ids = filters.id?.split(",");
	const states = params.states?.length ? params.states : ids ? [...LIST_STATES] : DEFAULT_LIST_STATES;
	// `since` follows the order: with sort created it bounds creation time, as the older `createdSince` did.
	const createdSince = filters.createdSince ?? (filters.sort === "created" ? filters.since : undefined);
	const updatedSince = filters.sort === "created" ? undefined : filters.since;
	const defaultLimit = params.states?.length || ids ? DEFAULT_LIST_LIMIT : DEFAULT_OPEN_LIMIT;
	const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? defaultLimit)));
	const offset = Math.max(0, Math.floor(params.offset ?? 0));
	// "me" is this session; a subagent never holds an item, so for it "me" is the parent session it works for.
	const assignees =
		filters.assignee === undefined
			? undefined
			: filters.assignee === "me"
				? [...(actor.owners ?? [session])]
				: [filters.assignee];
	const query: ListQuery = {
		states,
		limit,
		offset,
		...(filters.query ? { query: filters.query } : {}),
		...(filters.from ? { from: filters.from } : {}),
		...(ids ? { ids } : {}),
		...(filters.title ? { title: filters.title } : {}),
		...(filters.parentId ? { parentId: filters.parentId } : {}),
		...(filters.type ? { types: [filters.type] } : {}),
		...(filters.priority ? { maxPriority: PRIORITIES.indexOf(filters.priority as (typeof PRIORITIES)[number]) } : {}),
		...(filters.tags ? { tags: filters.tags } : {}),
		...(filters.paths ? { paths: filters.paths.map((entry) => repoRelative(entry, repoRoot)) } : {}),
		...(filters.dependsOn
			? { dependsOn: filters.dependsOn.map((ref) => (typeof ref === "string" ? ref : ref.id)) }
			: {}),
		...(filters.blocked !== undefined ? { blocked: filters.blocked } : {}),
		...(assignees ? { assignees } : {}),
		...(updatedSince ? { updatedSince: Date.parse(updatedSince) } : {}),
		...(createdSince ? { createdSince: Date.parse(createdSince) } : {}),
		...(filters.sort ? { sort: filters.sort } : {}),
	};
	const { items, total, pathMatches } = store.list(query);
	const marks = store.marks(items, actor.id, actor.owners);
	const lines = items.map((item) => {
		const line = itemLine(item, actor.id, actor.owners, marks.get(item.ref));
		const why = pathMatches?.get(item.ref)?.reason;
		return why ? `${line} — matched: ${visibleControls(why)}` : line;
	});
	if (lines.length === 0) {
		const others = Object.keys(filters).filter((key) => !["query", "from", "sort"].includes(key));
		lines.push(
			`No ${states.join("/")} items${filters.query ? ` matching "${visibleControls(filters.query)}"` : ""}${filters.from ? ` from ${visibleControls(filters.from)}` : ""}${others.length ? ` (filters: ${others.join(", ")})` : ""}.`,
		);
	}
	if (total > offset + items.length) {
		lines.push(`${total - offset - items.length} more.`);
		lines.push(
			`Next: backlog ${JSON.stringify({ op: "list", states, ...filters, limit, offset: offset + items.length })}`,
		);
	}
	const triage = states.includes("backlog") ? 0 : store.counts().items.backlog;
	if (triage > 0) lines.push(`${triage} proposed item(s) await triage (list with states: ["backlog"]).`);
	return textResult(lines.join("\n"), { shown: items.length, total });
}
