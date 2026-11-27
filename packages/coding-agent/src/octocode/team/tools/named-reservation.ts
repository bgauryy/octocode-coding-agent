import { reservationPath } from "../../shared/home.ts";

const MAX_WORDS = 4000;

/**
 * The reservation a command's text runs into: the first word of the line (inside quoted code too) that names a path another
 * agent has reserved, as `reservation` (the check every file write uses) answers for it, or undefined when no word does.
 * Inline interpreter code cannot be read for what it writes, but it cannot reach a reserved file without spelling it, so
 * only a line that names one is held back. Words resolve against `cwd` like the paths of a shell write.
 */
export function namedReservation(
	command: string,
	cwd: string,
	reservation: (absolute: string, display: string) => string | undefined,
): string | undefined {
	const words = new Set(
		command
			.split(/[\s'"`()[\]{},;|&<>=:*?$!#\\]+/)
			.map((word) => word.replace(/^\.{3,}|\.+$/g, ""))
			.filter((word) => /[\p{L}\p{N}]/u.test(word)),
	);
	let checked = 0;
	for (const word of words) {
		if (++checked > MAX_WORDS) break;
		const reason = reservation(reservationPath(cwd, word), word);
		if (reason) return reason;
	}
	return undefined;
}
