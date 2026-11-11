/**
 * The `until` kinds this version no longer takes: `command` covers both. A call that names one is refused with its
 * `command` form, and a timer stored with one ends with the same note at its next check (`scheduler.ts`). The stored text
 * of a removed kind has the shape of its old argument, so one reader serves both.
 */
const REMOVED = {
	file(value: unknown): string {
		const { path, is } = record(value);
		const target = shellWord(path, "path");
		if (is === "exists") return `test -e ${target}`;
		if (is === "absent") return `test ! -e ${target}`;
		return `test ${target} -nt mark (after \`touch mark\`; \`test -e ${target}\` waits for it to exist)`;
	},
	port(value: unknown): string {
		const { port, host } = record(value);
		return `nc -z ${shellWord(host, "localhost")} ${typeof port === "number" ? port : 3000}`;
	},
} as const;

type RemovedKind = keyof typeof REMOVED;

const isRemoved = (kind: string): kind is RemovedKind => Object.hasOwn(REMOVED, kind);

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** `value` as one shell word, or `fallback` when it is not a usable string. */
function shellWord(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

const note = (kind: RemovedKind, value: unknown) =>
	`until.${kind} was removed; set the timer with until.command instead: ${REMOVED[kind](value)}`;

/** Why an `until` argument is refused when it names a removed kind, with the `command` that replaces it; else undefined. */
export function removedUntil(until: unknown): string | undefined {
	const given = record(until);
	const kind = Object.keys(given).find((key) => isRemoved(key) && given[key] !== undefined);
	return kind && isRemoved(kind) ? note(kind, given[kind]) : undefined;
}

/** Why a stored condition can no longer be checked, when its kind (or its `check` trigger's) was removed; else undefined. */
export function removedStored(kind: string | null, stored: string | null): string | undefined {
	if (kind === null || stored === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(stored);
		if (isRemoved(kind)) return note(kind, parsed);
		const on = kind === "check" ? record(record(parsed).on) : {};
		return typeof on.kind === "string" && isRemoved(on.kind) && typeof on.value === "string"
			? note(on.kind, JSON.parse(on.value))
			: undefined;
	} catch {
		// Stored text that is not JSON: the kind alone still names the replacement.
		return isRemoved(kind) ? note(kind, undefined) : undefined;
	}
}
