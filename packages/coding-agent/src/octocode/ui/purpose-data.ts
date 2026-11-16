import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";

export interface StatedPurpose {
	row?: number;
	mainGoal?: string;
	reasoning?: string;
	reason?: string;
}

export const cleanPurposeText = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	return sanitizeTerminalText(value).replace(/\s+/g, " ").trim() || undefined;
};

function stated(records: Record<string, unknown>[], row?: number): StatedPurpose | undefined {
	const first = (key: string) => records.map((record) => cleanPurposeText(record[key])).find(Boolean);
	const mainGoal = first("mainGoal");
	const reasoning = first("reasoning");
	const reason = first("reason");
	if (!mainGoal && !reasoning && !reason) return undefined;
	return { row, mainGoal, reasoning, reason: reason !== reasoning ? reason : undefined };
}

/** Only the explicit purpose fields and known query envelopes; never arbitrary payload arrays or source text. */
export function statedPurposes(value: unknown, returned = false): StatedPurpose[] {
	const inner = returned && isRecord(value) ? value.structuredContent : undefined;
	const data = isRecord(inner) || Array.isArray(inner) ? inner : value;
	const purposes: StatedPurpose[] = [];
	const rows = (list: unknown[]) => {
		for (const [position, row] of list.entries()) {
			if (!isRecord(row)) continue;
			const index =
				returned && typeof row.index === "number" && Number.isInteger(row.index) && row.index >= 0
					? row.index
					: position;
			const purpose = stated(returned && isRecord(row.data) ? [row, row.data] : [row], index);
			if (purpose) purposes.push(purpose);
		}
	};
	if (returned && Array.isArray(data)) rows(data);
	else if (isRecord(data)) {
		const top = stated([data]);
		if (top) purposes.push(top);
		if (Array.isArray(data.queries)) rows(data.queries);
		if (returned && Array.isArray(data.results)) rows(data.results);
	}
	const seen = new Set<string>();
	return purposes.filter((purpose) => {
		const key = JSON.stringify(purpose);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Omit repeated metadata only for the same query (or an identical top-level field). */
export function remainingPurposes(purposes: StatedPurpose[], shown: StatedPurpose[]): StatedPurpose[] {
	return purposes.flatMap((purpose) => {
		const same = shown.filter((entry) => entry.row === purpose.row);
		const keep = (text: string | undefined) =>
			text && !same.some((entry) => [entry.mainGoal, entry.reasoning, entry.reason].includes(text)) ? text : undefined;
		const next = {
			row: purpose.row,
			mainGoal: keep(purpose.mainGoal),
			reasoning: keep(purpose.reasoning),
			reason: keep(purpose.reason),
		};
		return next.mainGoal || next.reasoning || next.reason ? [next] : [];
	});
}

/** A display copy: dedicated purpose rows own only the fields they actually show. */
export function purposeArguments(args: unknown, purposes: StatedPurpose[], compactQueries = false): unknown {
	if (!isRecord(args) || purposes.length === 0) return args;
	const strip = (record: Record<string, unknown>, row?: number) => {
		const copy = { ...record };
		for (const key of ["mainGoal", "reasoning", "reason"] as const)
			if (
				purposes.some(
					(purpose) =>
						purpose.row === row && purpose[key] !== undefined && purpose[key] === cleanPurposeText(record[key]),
				)
			)
				delete copy[key];
		return copy;
	};
	const copy = strip(args);
	if (Array.isArray(args.queries)) {
		const queries = args.queries.map((query, position) => {
			if (!isRecord(query)) return query;
			return strip(query, position);
		});
		copy.queries = compactQueries
			? queries
					.map((query, index) => {
						const fields = isRecord(query)
							? Object.entries(query)
									.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
									.join(" ")
							: JSON.stringify(query);
						return `Query ${index + 1}: ${fields}`;
					})
					.join("\n")
			: queries;
	}
	return copy;
}
