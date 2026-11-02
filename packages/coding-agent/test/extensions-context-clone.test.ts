import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { describe, expect, it } from "vitest";
import { cloneMessages } from "../src/core/features/runner/clone-messages.ts";
import { dispatchContext } from "../src/core/features/runner/emit-transforms.ts";
import type { Extension } from "../src/core/features/types.ts";

type Handler = (event: { messages: AgentMessage[] }) => unknown;

function host(handlers: { context?: Handler }) {
	const map = new Map<string, Handler[]>();
	for (const [event, handler] of Object.entries(handlers)) map.set(event, [handler]);
	const extension = { path: "test", handlers: map } as unknown as Extension;
	return {
		extensions: [extension],
		createContext: () => ({}),
		emitError: () => {},
	} as never;
}

function transcript(): AgentMessage[] {
	return [
		{ role: "user", content: [{ type: "image", data: "A".repeat(1000), mimeType: "image/png" }], timestamp: 1 },
		{ role: "user", content: "hello", timestamp: 2 },
	] as AgentMessage[];
}

describe("dispatchContext copies", () => {
	it("does not copy messages when no handler can observe them", async () => {
		const messages = transcript();
		const result = await dispatchContext(host({}), messages);
		expect(result).toEqual(messages);
		expect(result).not.toBe(messages);
		expect(result[0]).toBe(messages[0]);
	});

	it("keeps a handler's edits away from the caller", async () => {
		const messages = transcript();
		const result = await dispatchContext(
			host({
				context: (e: { messages: AgentMessage[] }) => {
					(e.messages[1] as { content: unknown }).content = "edited";
				},
			}),
			messages,
		);
		expect(result[1]).toMatchObject({ content: "edited" });
		expect(messages[1]).toMatchObject({ content: "hello" });
		expect(result[0]).not.toBe(messages[0]);
	});
});

describe("cloneMessages", () => {
	it("copies nested plain data, shares strings and clones other objects", () => {
		const date = new Date(5);
		const original: Array<{
			role: string;
			content: Array<{ type: string; text: string }>;
			meta: { date: Date; list: number[] };
		}> = [{ role: "user", content: [{ type: "text", text: "x".repeat(10) }], meta: { date, list: [1] } }];
		const copy = cloneMessages(original as never) as unknown as typeof original;
		expect(copy).toEqual(original);
		expect(copy[0]).not.toBe(original[0]);
		expect(copy[0].content[0]).not.toBe(original[0].content[0]);
		expect(copy[0].meta.list).not.toBe(original[0].meta.list);
		expect(copy[0].meta.date).not.toBe(date);
		expect(copy[0].meta.date.getTime()).toBe(5);
	});

	it("keeps cycles", () => {
		const node: Record<string, unknown> = { name: "n" };
		node.self = node;
		const [copy] = cloneMessages([node] as never) as unknown as Array<Record<string, unknown>>;
		expect(copy.self).toBe(copy);
		expect(copy).not.toBe(node);
	});
});
