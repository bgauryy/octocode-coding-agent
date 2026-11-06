import path from "node:path";
import { type ConditionSpec, text } from "./types.ts";

type Unlocked = { kind: "unlocked"; path: string };

/** `unlocked`: no other agent's reservation covers the path. Another process releasing a path moves the database file, which pokes a check. */
export const unlockedSpec: ConditionSpec<Unlocked> = {
	kind: "unlocked",
	parse: (value) => ({ kind: "unlocked", path: text(value, "until.unlocked") }),
	encode: (condition) => condition.path,
	decode: (stored) => ({ kind: "unlocked", path: stored }),
	describe: (condition) => `${condition.path} unlocked`,
	safetyMs: 30_000,
	pollMs: 15_000,
	async check(condition, { cwd, deps }) {
		const held = deps.reservation(path.resolve(cwd, condition.path), condition.path);
		return { met: held === undefined, exit: null, output: held ?? `${condition.path} is not reserved.` };
	},
	watch: (_condition, { deps }, poke) => deps.watchDatabase(poke),
};
