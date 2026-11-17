import { describe, expect, it } from "vitest";
import { anthropicMessages } from "../src/anthropic.ts";
import { script } from "../src/gateway.ts";
import { gateway } from "./helpers.ts";

const addition = {
	type: "tool_addition",
	tool: {
		type: "tool_definition",
		definition: { name: "late_tool", description: "d", input_schema: { type: "object" } },
	},
	cache_control: { type: "ephemeral" },
};
const removal = { type: "tool_removal", tool: { type: "tool_reference", name: "base_tool" } };

const body = (messages: unknown[], system: unknown = "base") => ({ model: "m", max_tokens: 10, system, messages });

describe("anthropicMessages keeps in-place tool changes and system structure", () => {
	it("keeps tool_addition and tool_removal blocks of a mid-conversation system message", () => {
		const out = anthropicMessages(
			body([
				{ role: "user", content: "hi" },
				{ role: "system", content: [{ type: "text", text: "updated" }, removal, addition] },
			]),
		);
		const update = out.at(-1);
		expect(update).toMatchObject({ role: "system", content: "updated" });
		expect(update?.blocks?.map((b) => b.type)).toEqual(["text", "tool_removal", "tool_addition"]);
		expect(update?.blocks?.[2]).toEqual(addition);
	});

	it("keeps a system message that holds only tool blocks (it used to vanish)", () => {
		const out = anthropicMessages(body([{ role: "system", content: [addition] }]));
		expect(out.map((m) => m.role)).toEqual(["system", "system"]);
		expect(out[1].blocks).toEqual([addition]);
	});

	it("keeps the block list of a top-level system array", () => {
		const system = [
			{ type: "text", text: "a", cache_control: { type: "ephemeral" } },
			{ type: "text", text: "b" },
		];
		const [sys] = anthropicMessages(body([], system));
		expect(sys.content).toBe("a\nb");
		expect(sys.blocks).toEqual(system);
	});

	it("adds no blocks to ordinary turns, a string system or text-only content (must-fail contrast)", () => {
		const out = anthropicMessages(
			body([
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
			]),
		);
		expect(out.some((m) => "blocks" in m)).toBe(false);
	});

	it("a request without tool blocks shows none to the matchers", () => {
		const out = anthropicMessages(body([{ role: "system", content: [{ type: "text", text: "only text" }] }]));
		expect(out[1].blocks?.filter((b) => b.type === "tool_addition" || b.type === "tool_removal")).toEqual([]);
	});

	it("the gateway trace carries the blocks, while the request hash ignores them", async () => {
		const gw = await gateway({ responder: script([{ text: "ok" }]) });
		const send = (b: unknown) =>
			fetch(`${gw.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(b),
			});
		await send(body([{ role: "user", content: "hi" }], "base"));
		await send(
			body([{ role: "user", content: "hi" }], [{ type: "text", text: "base", cache_control: { type: "ephemeral" } }]),
		);
		await send(
			body([
				{ role: "user", content: "hi" },
				{ role: "system", content: [addition] },
			]),
		);
		const [a, b, c] = gw.trace.requests;
		expect(a.hash).toBe(b.hash);
		expect(b.messages[0].blocks).toHaveLength(1);
		expect(c.hash).not.toBe(a.hash);
		expect(c.messages.at(-1)?.blocks).toEqual([addition]);
	});
});
