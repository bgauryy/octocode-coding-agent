import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { cloneApplicationEvent } from "../src/core/application/clone-event.ts";

describe("stream event delivery", () => {
	it("isolates every mutable block field without changing the serialized contract", () => {
		const event: ApplicationEvent = {
			type: "message.delta",
			messageId: "m",
			delta: "界",
			text: "a".repeat(400_000),
			content: [
				{
					id: "text",
					type: "text",
					text: "a".repeat(400_000),
					annotations: [{ type: "citation", title: "source" }],
					full: { id: "full", mimeType: "text/plain", size: 400_000 },
				},
				{ id: "thinking", type: "thinking", text: "reasoning" },
				{ id: "tool", type: "toolCall", name: "file", toolCallId: "call", arguments: { paths: ["original"] } },
				{ id: "image", type: "image", asset: { id: "img", mimeType: "image/png", size: 5 } },
				{ id: "resource", type: "resource", uri: "test:", text: undefined },
			],
			full: undefined,
		};
		const first = cloneApplicationEvent(event);
		const second = cloneApplicationEvent(event);
		expect(first).toEqual(JSON.parse(JSON.stringify(event)));
		if (first.type !== "message.delta") throw new Error("unexpected event");
		const [text, , tool, image] = first.content!;
		if (text.type !== "text" || tool.type !== "toolCall" || image.type !== "image")
			throw new Error("unexpected blocks");
		text.annotations![0].title = "changed";
		text.full!.size = 1;
		(tool.arguments as { paths: string[] }).paths.push("changed");
		image.asset.id = "changed";
		first.content!.pop();
		expect(second).toEqual(JSON.parse(JSON.stringify(event)));
	});
	it("preserves append-only events and isolates their asset descriptors", () => {
		const event: ApplicationEvent = {
			type: "message.delta",
			messageId: "m",
			delta: "append",
			block: { index: 0, length: 4, full: { id: "full", mimeType: "text/plain", size: 10 } },
		};
		const copy = cloneApplicationEvent(event);
		expect(copy).toEqual(event);
		if (copy.type === "message.delta") copy.block!.full!.size = 20;
		expect(event.block!.full!.size).toBe(10);
	});
});
