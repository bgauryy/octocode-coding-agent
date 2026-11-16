import type { ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { describe, expect, it, vi } from "vitest";
import { PersistentMap } from "@octocodeai/octocode-common/persistent-map";
import { transcriptHistory } from "../src/core/application/transcript-history.ts";

const message = (id: string, order?: number, toolCallId?: string): ApplicationMessage => ({
	id,
	role: "assistant",
	text: id,
	complete: true,
	...(order === undefined ? {} : { order }),
	...(toolCallId ? { toolCallId } : {}),
});
const tool = (id: string, order?: number, messageId?: string): ApplicationTool => ({
	toolCallId: id,
	toolName: "inspect",
	text: id,
	status: "completed",
	...(order === undefined ? {} : { order }),
	...(messageId === undefined ? {} : { messageId }),
});

function reference(
	messages: ReadonlyMap<string, ApplicationMessage>,
	tools: ReadonlyMap<string, ApplicationTool>,
	before?: string,
	limit = 50,
) {
	const all = [...messages.values()];
	const end = before === undefined ? all.length : all.findIndex((entry) => entry.id === before);
	if (end < 0) throw new Error("History cursor is not in this session");
	const page = all.slice(Math.max(0, end - Math.max(1, Math.min(100, limit))), end);
	const ids = new Set(page.map((entry) => entry.id));
	const calls = new Set(page.flatMap((entry) => (entry.toolCallId ? [entry.toolCallId] : [])));
	const from = page[0]?.order ?? 0;
	const until = all[end]?.order ?? Number.POSITIVE_INFINITY;
	return {
		messages: page,
		tools: [...tools.values()].filter(
			(entry) =>
				(entry.messageId !== undefined && ids.has(entry.messageId)) ||
				calls.has(entry.toolCallId) ||
				((entry.order ?? -1) >= from && (entry.order ?? -1) < until),
		),
		...(page.length ? { before: page[0].id } : {}),
		hasMore: end > page.length,
	};
}

describe("indexed transcript history", () => {
	it("matches original paging for unordered tools, both owners, missing orders and tool-only gaps", () => {
		const messages = new Map(
			Array.from({ length: 83 }, (_, index) => [
				`key-${index}`,
				message(`m${index}`, index % 11 ? index * 3 : undefined, index % 3 ? undefined : `t${index}`),
			]),
		);
		const tools = new Map(
			Array.from({ length: 147 }, (_, index) => [
				`key-${index}`,
				tool(`t${index}`, index % 7 ? (index * 29) % 250 : undefined, index % 5 ? undefined : `m${index % 83}`),
			]),
		);
		const immutableMessages = PersistentMap.from(messages);
		const immutableTools = PersistentMap.from(tools);
		for (const before of [undefined, ...[...messages.values()].map((entry) => entry.id)])
			for (const limit of [1, 7, 50, 100])
				expect(transcriptHistory(immutableMessages, immutableTools, { before, limit })).toEqual(
					reference(messages, tools, before, limit),
				);
		expect(() => transcriptHistory(immutableMessages, immutableTools, { before: "missing" })).toThrow("History cursor");
		expect(transcriptHistory(PersistentMap.empty(), immutableTools)).toEqual(reference(new Map(), tools));
	});

	it("reuses each immutable version's indexes without traversing all values per page", () => {
		const messages = PersistentMap.from(
			new Map(Array.from({ length: 1000 }, (_, i) => [`m${i}`, message(`m${i}`, 2 * i + 1, `t${i}`)])),
		);
		const tools = PersistentMap.from(new Map(Array.from({ length: 1000 }, (_, i) => [`t${i}`, tool(`t${i}`, 2 * i)])));
		const messageValues = vi.spyOn(messages, "values");
		const toolValues = vi.spyOn(tools, "values");
		let before: string | undefined;
		let count = 0;
		do {
			const page = transcriptHistory(messages, tools, { before, limit: 10 });
			count += page.messages.length;
			if (!page.hasMore) break;
			before = page.before;
		} while (before !== undefined);
		expect(count).toBe(1000);
		expect(messageValues).toHaveBeenCalledTimes(1);
		expect(toolValues).toHaveBeenCalledTimes(1);
	});

	it("keeps older immutable versions exact after replacements and divergent branches", () => {
		const messages = PersistentMap.empty<ApplicationMessage>().set("a", message("a", 1));
		const tools = PersistentMap.empty<ApplicationTool>().set("t", tool("t", 0, "a"));
		const saved = transcriptHistory(messages, tools);
		const newer = messages.set("b", message("b", 4));
		const changed = tools.set("t", { ...tool("t", 3, "b"), text: "new result" });
		expect(transcriptHistory(newer, changed)).toEqual(reference(newer, changed));
		const branch = messages.set("c", message("c", 7));
		expect(transcriptHistory(branch, tools)).toEqual(reference(branch, tools));
		expect(transcriptHistory(messages, tools)).toEqual(saved);
	});

	it("does not cache mutable Map contents or their entry values", () => {
		const messages = new Map([["a", message("a", 1)]]);
		const tools = new Map([["t", tool("t", 0, "a")]]);
		transcriptHistory(messages, tools);
		messages.set("b", message("b", 4));
		tools.get("t")!.messageId = "b";
		tools.get("t")!.order = 3;
		expect(transcriptHistory(messages, tools, { limit: 1 })).toEqual(reference(messages, tools, undefined, 1));
		messages.delete("a");
		tools.clear();
		expect(transcriptHistory(messages, tools)).toEqual(reference(messages, tools));
	});
});
