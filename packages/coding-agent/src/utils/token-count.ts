/** Decimal k/m suffixes follow the provider catalog's token units. */
export function parseContextSize(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value.trim());
	if (!match) return undefined;
	const tokens = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1000 : 1);
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}
