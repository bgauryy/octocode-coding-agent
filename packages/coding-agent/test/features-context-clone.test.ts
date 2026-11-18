import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { cloneMessages, onlyReadsMessages, readsMessagesOnly } from "../src/core/features/runner/clone-messages.ts";
import { SessionBus } from "../src/core/features/bus/session-bus.ts";
import { dispatchContext } from "../src/core/features/runner/emit-transforms.ts";
import type { FeatureRecord } from "../src/core/features/types.ts";
import { createFeatureRuntime, loadFeatureFromFactory } from "./helpers/features.ts";

type Handler = (event: { messages: AgentMessage[] }) => unknown;

function host(handlers: { context?: Handler | Handler[] }) {
	const map = new Map<string, Handler[]>();
	for (const [event, handler] of Object.entries(handlers)) map.set(event, [handler].flat());
	const feature = { path: "test", handlers: map } as unknown as FeatureRecord;
	return {
		extensions: [feature],
		bus: new SessionBus([feature]),
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

describe("dispatchContext with read-only handlers", () => {
	type Seen = { messages: AgentMessage[] };
	const text = (message: AgentMessage) => (message as { content: unknown }).content;

	it("hands read-only handlers the messages themselves and copies nothing", async () => {
		const messages = transcript();
		const seen: AgentMessage[][] = [];
		const reader = readsMessagesOnly((e: Seen) => {
			seen.push(e.messages);
		});
		const result = await dispatchContext(host({ context: [reader, reader] }), messages);
		expect(seen).toHaveLength(2);
		for (const view of seen) expect(view.every((message, i) => message === messages[i])).toBe(true);
		expect(result).not.toBe(messages);
		expect(result.every((message, i) => message === messages[i])).toBe(true);
	});

	it("copies before the first handler that may edit, and keeps its edits from the caller", async () => {
		const messages = transcript();
		const views: Array<{ who: string; messages: AgentMessage[]; content: unknown }> = [];
		const reader = (who: string) =>
			readsMessagesOnly((e: Seen) => {
				views.push({ who, messages: e.messages, content: text(e.messages[1]) });
			});
		const editor = (e: Seen) => {
			views.push({ who: "editor", messages: e.messages, content: text(e.messages[1]) });
			(e.messages[1] as { content: unknown }).content = "edited";
		};
		const result = await dispatchContext(host({ context: [reader("before"), editor, reader("after")] }), messages);
		const [before, edit, after] = views;
		expect(before.messages[1]).toBe(messages[1]);
		expect(edit.messages[1]).not.toBe(messages[1]);
		expect(edit.content).toBe("hello");
		// A handler after the editor sees its edit (handlers chain), on the copy.
		expect(after.content).toBe("edited");
		expect(after.messages[1]).toBe(edit.messages[1]);
		expect(text(result[1])).toBe("edited");
		expect(text(messages[1])).toBe("hello");
		expect(result[0]).not.toBe(messages[0]);
	});

	it("copies a read-only handler's returned list too before an editor runs", async () => {
		const messages = transcript();
		const extra = { role: "user", content: "added", timestamp: 3 } as AgentMessage;
		const reader = readsMessagesOnly((e: Seen) => ({ messages: [...e.messages, extra] }));
		const editor = (e: Seen) => {
			for (const message of e.messages) (message as { content: unknown }).content = "edited";
		};
		const result = await dispatchContext(host({ context: [reader, editor] }), messages);
		expect(result.map(text)).toEqual(["edited", "edited", "edited"]);
		expect(messages.map(text)).toEqual(transcript().map(text));
		expect(text(extra)).toBe("added");
	});

	it("keeps the declaration through FeatureSetup.on", async () => {
		const handlers: unknown[] = [];
		const feature = await loadFeatureFromFactory(
			(api) => {
				api.bus.on(
					"context",
					readsMessagesOnly(async () => undefined),
				);
				api.bus.on("context", async () => undefined);
			},
			process.cwd(),
			createEventBus(),
			createFeatureRuntime(),
		);
		handlers.push(...(feature.handlers.get("context") ?? []));
		expect(handlers.map(onlyReadsMessages)).toEqual([true, false]);
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

	it("shares an assistant message's request trace and copies everything else", () => {
		const requestTrace = { layers: [{ kind: "message", index: 0, chars: 5, hash: "0123456789abcdef" }] };
		const original = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }], requestTrace, timestamp: 1 },
		] as unknown as AgentMessage[];
		const [copy] = cloneMessages(original) as unknown as Array<{ content: unknown[]; requestTrace: unknown }>;
		expect(copy.requestTrace).toBe(requestTrace);
		expect(copy).not.toBe(original[0]);
		expect(copy.content).not.toBe((original[0] as unknown as { content: unknown[] }).content);
		expect(copy).toEqual(original[0]);
	});

	it("keeps cycles", () => {
		const node: Record<string, unknown> = { name: "n" };
		node.self = node;
		const [copy] = cloneMessages([node] as never) as unknown as Array<Record<string, unknown>>;
		expect(copy.self).toBe(copy);
		expect(copy).not.toBe(node);
	});
});
