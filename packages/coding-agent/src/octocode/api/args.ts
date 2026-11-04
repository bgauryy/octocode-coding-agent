import { describeInstance, type InstanceRecord, selectInstance } from "./registry.ts";

export const API_COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
	list: [],
	status: ["to"],
	send: ["to", "from", "wait", "mode", "key", "session", "timeout", "require-idle"],
	watch: ["to", "types", "top-level", "since"],
	abort: ["to"],
	external: ["to"],
};
const KNOWN_FLAGS = new Set(Object.values(API_COMMAND_FLAGS).flat());
const BOOLEAN_FLAGS = new Set(["wait", "top-level", "require-idle"]);

/** The `--flag value` pairs and the plain words of a command line. A flag that needs a value and has none is an error: it never falls back to a default. */
export function parseArgs(args: string[], command?: string): { flags: Map<string, string | true>; words: string[] } {
	const flags = new Map<string, string | true>();
	const words: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			words.push(...args.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			words.push(arg);
			continue;
		}
		const flag = arg.slice(2);
		if (!KNOWN_FLAGS.has(flag)) throw new Error(`Unknown flag ${arg}. Use -- before message text starting with --.`);
		if (command && (!Object.hasOwn(API_COMMAND_FLAGS, command) || !API_COMMAND_FLAGS[command].includes(flag)))
			throw new Error(`${arg} is not valid for ${command}.`);
		if (flags.has(flag)) throw new Error(`${arg} was supplied more than once.`);
		if (BOOLEAN_FLAGS.has(flag)) flags.set(flag, true);
		else {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
			flags.set(flag, value);
			index += 1;
		}
	}
	return { flags, words };
}

export function integerFlag(
	flags: ReadonlyMap<string, string | true>,
	name: string,
	range: { min: number; max: number },
): number | undefined {
	const value = flags.get(name);
	if (value === undefined) return undefined;
	const number = Number(value);
	if (
		typeof value !== "string" ||
		!/^\d+$/.test(value) ||
		!Number.isSafeInteger(number) ||
		number < range.min ||
		number > range.max
	)
		throw new Error(`--${name} must be a whole number from ${range.min} to ${range.max}.`);
	return number;
}

/**
 * The instance `--to` names (see `matchInstances` for what it accepts); without it, the only running one, or the one in
 * this directory when several run.
 */
export function pickInstance(instances: InstanceRecord[], to: string | undefined, cwd: string): InstanceRecord {
	if (to !== undefined) return selectInstance(instances, to);
	const found = instances.length > 1 ? instances.filter((entry) => entry.cwd === cwd) : instances;
	if (found.length === 1) return found[0];
	if (found.length > 1)
		throw new Error(`Several instances match; pass --to <id>: ${found.map(describeInstance).join("; ")}`);
	throw new Error(
		instances.length
			? `No running instance matches this directory; pass --to <id>: ${instances.map(describeInstance).join("; ")}`
			: "No running instance matches. Start Octocode, or run /api on in a session whose API is off.",
	);
}
