import { LIST_STATES } from "@octocodeai/octocode-contracts/snapshot";
import { type ConditionSpec, fields, text } from "./types.ts";

type Item = { kind: "item"; ref: string; state: string };

/** `item`: a backlog item of this workspace is in the named state (`closed`: closed without completion). */
export const itemSpec: ConditionSpec<Item> = {
	kind: "item",
	parse(value) {
		const given = fields(value, "item", ["ref", "state"]);
		const state = text(given.state, "until.item.state");
		if (!(LIST_STATES as readonly string[]).includes(state))
			throw new Error(`until.item.state is one of ${LIST_STATES.join(", ")}.`);
		return { kind: "item", ref: text(given.ref, "until.item.ref"), state };
	},
	encode: (condition) => JSON.stringify({ ref: condition.ref, state: condition.state }),
	decode(stored) {
		const parsed = JSON.parse(stored) as Partial<Item>;
		return typeof parsed.ref === "string" && typeof parsed.state === "string"
			? { kind: "item", ref: parsed.ref, state: parsed.state }
			: undefined;
	},
	describe: (condition) => `${condition.ref} is ${condition.state}`,
	safetyMs: 60_000,
	pollMs: 15_000,
	async check(condition, { deps }) {
		const state = deps.item(condition.ref);
		if (state === undefined)
			return { met: false, exit: null, output: "", refused: `no backlog item ${condition.ref} in this workspace` };
		return { met: state === condition.state, exit: null, output: `${condition.ref} is ${state}.` };
	},
	watch: (_condition, { deps }, poke) => deps.watchDatabase(poke),
};
