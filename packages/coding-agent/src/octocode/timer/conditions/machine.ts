import { type ConditionSpec, fields } from "./types.ts";

type Machine = { kind: "machine"; below?: number; above?: number; for: number };

/** Samples a wait may ask to hold: the sampler keeps a day, and a streak this long is hours at the default interval. */
const MAX_FOR = 60;

function count(value: unknown, name: string, positive: boolean): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0))
		throw new Error(`${name} must be a ${positive ? "positive" : "non-negative"} number.`);
	return value;
}

/**
 * `machine`: the host's load per CPU core, read from the machine samples the sampler lease holder keeps (never by running
 * a command): met when the newest `for` samples are all below `below` (or all above `above`). One of the two bounds.
 */
export const machineSpec: ConditionSpec<Machine> = {
	kind: "machine",
	parse(value) {
		const given = fields(value, "machine", ["below", "above", "for"]);
		const below = count(given.below, "until.machine.below", true);
		const above = count(given.above, "until.machine.above", false);
		if ((below === undefined) === (above === undefined))
			throw new Error("until.machine takes exactly one of below or above: the load per core to wait for.");
		const streak = count(given.for, "until.machine.for", true) ?? 1;
		if (!Number.isInteger(streak) || streak > MAX_FOR)
			throw new Error(`until.machine.for is a whole number of samples, 1 to ${MAX_FOR}.`);
		return { kind: "machine", ...(below === undefined ? { above } : { below }), for: streak };
	},
	encode: (condition) => JSON.stringify(condition),
	decode(stored) {
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		const bound = typeof parsed.below === "number" ? { below: parsed.below } : { above: Number(parsed.above) };
		if (Object.values(bound)[0] === undefined || Number.isNaN(Object.values(bound)[0])) return undefined;
		return { kind: "machine", ...bound, for: typeof parsed.for === "number" ? parsed.for : 1 };
	},
	describe: (condition) =>
		`load per core ${condition.below === undefined ? `above ${condition.above}` : `below ${condition.below}`} for ${condition.for} sample${condition.for === 1 ? "" : "s"}`,
	// A sample arrives each sampler tick, and the database file changes with it: the file watch pokes a check.
	safetyMs: 60_000,
	pollMs: 30_000,
	async check(condition, { deps }) {
		if (!deps.machine) return { met: false, exit: null, output: "", refused: "this session reads no machine samples" };
		const samples = deps.machine(condition.for);
		const loads = samples.map((sample) => (sample.cores > 0 ? sample.load1 / sample.cores : Number.NaN));
		const holds = (load: number) => (condition.below === undefined ? load > condition.above! : load < condition.below);
		const latest = loads[0];
		const met = loads.length >= condition.for && loads.every(holds);
		const reading =
			latest === undefined || Number.isNaN(latest) ? "no sample yet" : `load ${latest.toFixed(2)} per core`;
		return { met, exit: null, output: met ? `${reading}: ${describe(condition)}.` : `${reading}.` };
	},
	watch: (_condition, { deps }, poke) => deps.watchDatabase(poke),
};

const describe = machineSpec.describe;
