import { LIST_STATES } from "@octocodeai/octocode-contracts/snapshot";
import { type ConditionSpec, fields, text } from "./types.ts";

type Item = { kind: "item"; ref: string; state: string };

/** Not a stored state: every `dependsOn` item of the ref is done or closed. */
const READY = "ready";

const refsOf = (ref: string) => ref.split(/[\s,]+/).filter(Boolean);

/** The refs of an `until.item.ref`: one string (comma or space joined) or an array, as the backlog tool's `ids`. */
function parseRefs(value: unknown): string {
	const parts = Array.isArray(value) ? value : [value];
	const refs = parts.flatMap((part) => refsOf(text(part, "until.item.ref")));
	if (!refs.length) throw new Error("until.item.ref must name at least one item.");
	return [...new Set(refs)].join(",");
}

/**
 * `item`: any of the backlog items of this workspace is in the named state (`closed`: closed without completion), or,
 * with state `ready`, has every `dependsOn` item done or closed.
 */
export const itemSpec: ConditionSpec<Item> = {
	kind: "item",
	parse(value) {
		const given = fields(value, "item", ["ref", "state"]);
		const state = text(given.state, "until.item.state");
		if (state !== READY && !(LIST_STATES as readonly string[]).includes(state))
			throw new Error(`until.item.state is one of ${LIST_STATES.join(", ")}, ${READY}.`);
		return { kind: "item", ref: parseRefs(given.ref), state };
	},
	encode: (condition) => JSON.stringify({ ref: condition.ref, state: condition.state }),
	decode(stored) {
		const parsed = JSON.parse(stored) as Partial<Item>;
		return typeof parsed.ref === "string" && typeof parsed.state === "string"
			? { kind: "item", ref: parsed.ref, state: parsed.state }
			: undefined;
	},
	describe: (condition) =>
		`${refsOf(condition.ref).length > 1 ? "any of " : ""}${condition.ref.replaceAll(",", ", ")} is ${condition.state}`,
	safetyMs: 60_000,
	pollMs: 15_000,
	async check(condition, { deps }) {
		const lines: string[] = [];
		let met = false;
		for (const ref of refsOf(condition.ref)) {
			const state = deps.item(ref);
			if (state === undefined)
				return { met: false, exit: null, output: "", refused: `no backlog item ${ref} in this workspace` };
			if (condition.state === READY) {
				const open = deps.blockers(ref) ?? [];
				met ||= open.length === 0;
				lines.push(
					open.length ? `${ref} waits on ${open.join(", ")}.` : `${ref} is ready: its dependsOn items are done.`,
				);
			} else {
				met ||= state === condition.state;
				lines.push(`${ref} is ${state}.`);
			}
		}
		return { met, exit: null, output: lines.join(" ") };
	},
	watch: (_condition, { deps }, poke) => deps.watchDatabase(poke),
};
