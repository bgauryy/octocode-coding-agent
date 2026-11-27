import type { AppliesWhen, ConfigApplied, ConfigOp, ConfigRefused, ConfigScope } from "./types.ts";

const scopeOf = (op: ConfigOp): ConfigScope => op.scope ?? "global";

export function applied(op: ConfigOp, appliesWhen: AppliesWhen, message: string): ConfigApplied {
	return { status: "applied", id: op.id, verb: op.verb, scope: scopeOf(op), appliesWhen, message };
}

export function refused(op: ConfigOp, reason: string, suggestions?: string[]): ConfigRefused {
	return {
		status: "refused",
		id: op.id,
		verb: op.verb,
		scope: scopeOf(op),
		reason,
		...(suggestions?.length ? { suggestions } : {}),
	};
}

/** The id's kind: the text before the first `:`; a settings key has none and is `setting`. */
export function kindOf(id: string): string {
	const colon = id.indexOf(":");
	return colon > 0 ? id.slice(0, colon) : "setting";
}

/** The id without its kind. */
export function nameOf(id: string): string {
	const colon = id.indexOf(":");
	return colon > 0 ? id.slice(colon + 1) : id;
}

/** Verbs a toggle-like entry accepts; others get the same refusal. */
export function onlySwitch(op: ConfigOp): ConfigRefused | undefined {
	if (op.verb === "enable" || op.verb === "disable") return undefined;
	return refused(op, `${op.id} can only be enabled or disabled, not "${op.verb}".`);
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j];
			row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[b.length];
}

/** Up to `limit` ids closest to `id`: those that contain it or are contained by it first, then by edit distance. */
export function closestIds(id: string, candidates: readonly string[], limit = 5): string[] {
	const wanted = id.toLowerCase();
	const ranked = candidates.map((candidate) => {
		const lower = candidate.toLowerCase();
		const contains = lower.includes(wanted) || wanted.includes(nameOf(lower));
		return { candidate, score: distance(wanted, lower) - (contains ? 1000 : 0) };
	});
	const maxDistance = Math.max(3, Math.floor(wanted.length / 2));
	return ranked
		.filter(({ score }) => score < 0 || score <= maxDistance)
		.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
		.slice(0, limit)
		.map(({ candidate }) => candidate);
}
