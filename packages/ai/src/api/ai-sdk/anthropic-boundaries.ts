import type { ModelMessage } from "ai";

export function preserveAnthropicBoundaries(body: Record<string, unknown>, messages: ModelMessage[]): void {
	if (!Array.isArray(body.messages)) return;
	const wire = body.messages as { role: string; content: unknown[] | string; [key: string]: unknown }[];
	let first = messages.findIndex((message) => message.role !== "system");
	if (first < 0) first = messages.length;
	const plan = messages.slice(first).map((message) => ({
		role: message.role === "tool" ? "user" : message.role,
		count: typeof message.content === "string" ? (message.content ? 1 : 0) : message.content.length,
		original: message.role,
		joinPrevious: message.providerOptions?.octocode?.joinPrevious === true,
		control: message.providerOptions?.anthropic?.cacheControl,
	}));
	const result: typeof wire = [];
	let index = 0;
	let offset = 0;
	for (let position = 0; position < plan.length; position++) {
		const target = plan[position];
		if (target.original === "system") {
			const source = wire[index];
			if (source?.role === "system") {
				if (target.control && Array.isArray(source.content) && source.content.length) {
					const blocks = source.content as Record<string, unknown>[];
					if (blocks.at(-1)?.type === "tool_addition") {
						for (const block of blocks) delete block.cache_control;
						blocks[blocks.length - 1].cache_control = target.control;
					}
				}
				result.push(source);
				index++;
				offset = 0;
			}
			continue;
		}
		let count = target.count;
		if (target.original === "tool") {
			while (plan[position + 1]?.original === "tool" || plan[position + 1]?.joinPrevious)
				count += plan[++position].count;
		}
		const source = wire[index];
		if (!source || source.role !== target.role || !Array.isArray(source.content)) continue;
		const parts = source.content.slice(offset, offset + count);
		if (parts.length) result.push({ ...source, content: parts });
		offset += parts.length;
		if (offset >= source.content.length) {
			index++;
			offset = 0;
		}
	}
	if (index < wire.length) {
		const source = wire[index];
		if (offset && Array.isArray(source.content)) result.push({ ...source, content: source.content.slice(offset) });
		else result.push(source);
		result.push(...wire.slice(index + 1));
	}
	body.messages = result;
}
