import { CHANGE_KINDS } from "../../shared/backlog-change.ts";
import { describeChange, inScope, needBacklog, splitList, watchBacklog } from "./backlog-wait.ts";
import { type BaseCondition, type ConditionSpec, fields, text } from "./types.ts";

type Changed = Extract<BaseCondition, { kind: "changed" }>;

const MAX_LISTED = 3;

const optional = (value: unknown, name: string): string | undefined =>
	value === undefined ? undefined : text(value, name);

/** The cursor a wait stored when it started: a whole number, or none for a wait not started yet. */
export function parseSince(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error(`${name} must be a whole number, 0 or more.`);
	return value;
}

/** The `change` field: comma-joined kinds from the backlog's change kinds. */
function parseKinds(value: unknown, name: string): string | undefined {
	const given = optional(value, name);
	if (given === undefined) return undefined;
	const kinds = splitList(given);
	const unknown = kinds.filter((kind) => !(CHANGE_KINDS as readonly string[]).includes(kind));
	if (unknown.length > 0)
		throw new Error(`${name} is one or more of ${CHANGE_KINDS.join(", ")}, not ${unknown.join(", ")}.`);
	return [...new Set(kinds)].join(",");
}

/**
 * `changed`: a change another writer made to the named items, to the items under an epic, or to items on a path since the
 * wait started. `since` is the audit cursor stored when it started (`armUntil`); the check reads the audit log after it, so a
 * change that happened while the feed missed it is still found. A change this session wrote never meets it.
 */
export const changedSpec: ConditionSpec<Changed> = {
	kind: "changed",
	parse(value) {
		const given = fields(value, "changed", ["ref", "epic", "path", "change", "since"]);
		const refs = optional(given.ref, "until.changed.ref");
		const epic = optional(given.epic, "until.changed.epic");
		const path = optional(given.path, "until.changed.path");
		if (!refs && !epic && !path) throw new Error("until.changed needs ref, epic or path: say which items to watch.");
		const change = parseKinds(given.change, "until.changed.change");
		const since = parseSince(given.since, "until.changed.since");
		return {
			kind: "changed",
			...(refs ? { ref: [...new Set(splitList(refs))].join(",") } : {}),
			...(epic ? { epic } : {}),
			...(path ? { path } : {}),
			...(change ? { change } : {}),
			...(since !== undefined ? { since } : {}),
		};
	},
	encode: (condition) => JSON.stringify(condition),
	decode(stored) {
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		const str = (key: string) => (typeof parsed[key] === "string" ? parsed[key] : undefined);
		const since = typeof parsed.since === "number" ? parsed.since : undefined;
		const [ref, epic, path, change] = [str("ref"), str("epic"), str("path"), str("change")];
		if (!ref && !epic && !path) return undefined;
		return {
			kind: "changed",
			...(ref ? { ref } : {}),
			...(epic ? { epic } : {}),
			...(path ? { path } : {}),
			...(change ? { change } : {}),
			...(since !== undefined ? { since } : {}),
		};
	},
	describe(condition) {
		const what = [
			condition.ref ? condition.ref.replaceAll(",", ", ") : undefined,
			condition.epic ? `epic ${condition.epic}` : undefined,
			condition.path ? `items on ${condition.path}` : undefined,
		].filter(Boolean);
		return `${condition.change ? condition.change.replaceAll(",", "/") : "any change"} on ${what.join(" and ")}`;
	},
	safetyMs: 60_000,
	pollMs: 15_000,
	async check(condition, { deps }) {
		const backlog = needBacklog(deps);
		if (condition.since === undefined)
			return { met: false, exit: null, output: "", refused: "item.changed was stored without its starting cursor." };
		const under = condition.epic === undefined ? undefined : backlog.under(condition.epic);
		if (condition.epic !== undefined && under === undefined)
			return { met: false, exit: null, output: "", refused: `no epic ${condition.epic} in this workspace` };
		const read = backlog.since(condition.since);
		if (read.resync)
			return {
				met: true,
				exit: null,
				output:
					"The audit history after this request began was pruned: reread the board, changes may have been missed.",
			};
		const scope = {
			refs: splitList(condition.ref),
			epic: condition.epic,
			path: condition.path,
			kinds: splitList(condition.change),
		};
		const reads = {
			under: under ? new Set(under) : undefined,
			paths: (ref: string) => backlog.detail(ref)?.paths ?? [],
		};
		const found = read.changes.filter((change) => !backlog.own(change.by) && inScope(change, scope, reads));
		if (found.length === 0) return { met: false, exit: null, output: "No matching change yet." };
		const shown = found.slice(0, MAX_LISTED).map(describeChange);
		return {
			met: true,
			exit: null,
			output: [...shown, ...(found.length > MAX_LISTED ? [`+${found.length - MAX_LISTED} more.`] : [])].join("\n"),
		};
	},
	watch: (condition, { deps }, poke) => {
		const refs = splitList(condition.ref);
		return watchBacklog(deps, (change) => refs.length === 0 || refs.includes(change.ref), poke);
	},
};
