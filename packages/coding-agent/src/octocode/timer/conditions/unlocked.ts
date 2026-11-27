import path from "node:path";
import { readRunLockSnap } from "../../graph/run-lock.ts";
import { watchRunLock } from "../../shared/run-lock-watch.ts";
import { type ConditionSpec, text } from "./types.ts";

type Unlocked = { kind: "unlocked"; path: string };

/** The word that names the host's full-run lock (a full test run or check) instead of a path. */
const FULL_RUN = "full-run";

/** Who holds the lock, for a wake: `yarn run check (agent swift-orca, item B915, job bash-3)`. */
function holder(): string | undefined {
	const snap = readRunLockSnap();
	if (!snap) return undefined;
	const names = [
		snap.agent && `agent ${snap.agent}`,
		snap.item && `item ${snap.item}`,
		snap.job && `job ${snap.job}`,
	].filter(Boolean);
	return `${snap.label}${names.length ? ` (${names.join(", ")})` : ""}`;
}

/**
 * `unlocked`: no other agent's reservation covers the path, or for `full-run` nobody holds the host's full-run lock.
 * Another process releasing a path moves the database file, which pokes a check; the lock is a file, so it is polled.
 */
export const unlockedSpec: ConditionSpec<Unlocked> = {
	kind: "unlocked",
	parse: (value) => ({ kind: "unlocked", path: text(value, "until.unlocked") }),
	encode: (condition) => condition.path,
	decode: (stored) => ({ kind: "unlocked", path: stored }),
	describe: (condition) => (condition.path === FULL_RUN ? "the full-run lock free" : `${condition.path} unlocked`),
	safetyMs: 30_000,
	pollMs: 15_000,
	async check(condition, { cwd, deps }) {
		if (condition.path === FULL_RUN) {
			const held = holder();
			return {
				met: held === undefined,
				exit: null,
				output: held ? `The full-run lock is held by ${held}.` : "The full-run lock is free.",
			};
		}
		const held = deps.reservation(path.resolve(cwd, condition.path), condition.path);
		return { met: held === undefined, exit: null, output: held ?? `${condition.path} is not reserved.` };
	},
	watch: (condition, { deps }, poke) => {
		const stopDatabase = deps.watchDatabase(poke);
		const stopLock = condition.path === FULL_RUN ? watchRunLock(poke) : undefined;
		return () => {
			stopDatabase();
			stopLock?.();
		};
	},
};
