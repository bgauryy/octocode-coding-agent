/** Available `provider/id` values that share name parts with the request, best first. */
export function closeModels(
	requested: string,
	available: readonly { provider: string; id: string }[],
	limit = 8,
): string[] {
	const parts = (text: string) =>
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean);
	const wanted = new Set(parts(requested));
	const ranked = available
		.map((model, index) => ({
			name: `${model.provider}/${model.id}`,
			index,
			score: parts(`${model.provider}/${model.id}`).filter((part) => wanted.has(part)).length,
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	return [...new Set(ranked.map((entry) => entry.name))].slice(0, limit);
}
