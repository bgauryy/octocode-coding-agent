import { describe, expect, it } from "vitest";
import { heldToolsFor, spanOf, withToolsOffNotice } from "../src/core/agent-session/tool-loadout/held-tools.ts";

const tool = (name: string) => ({ name, description: name, parameters: { type: "object" } });
const system = (...names: string[]) => ({ role: "system", content: "", toolsAdded: names.map(tool), timestamp: 0 });

const NONE = { api: "google-generative-ai", id: "g" };
const ADDITIONS = {
	api: "openai-completions",
	id: "o",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
};
const CHANGES = {
	api: "anthropic-messages",
	id: "a",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

function held(model: unknown, declared: string[]) {
	const session = { model, agent: { state: { messages: [system(...declared)] } } } as never;
	const spaces: Record<string, string> = { mcp__s__a: "mcp__s", mcp__s__b: "mcp__s" };
	return heldToolsFor(
		() => session,
		(name) => spaces[name],
	);
}

describe("HeldTools", () => {
	for (const [label, model] of [
		["none", NONE],
		["additions", ADDITIONS],
	] as const) {
		it(`${label}: a disable stays declared, is announced and refused with an alternative`, () => {
			const h = held(model, ["bash", "web", "file"]);
			const hidden = h.apply(["bash", "web", "file"], ["bash", "file"], new Set());
			expect([...h.off]).toEqual(["web"]);
			expect(hidden.size).toBe(0);
			expect(h.refusal("web", ["bash", "file"])).toContain("Use bash, file instead");
			expect(h.refusal("bash", ["bash"])).toBeUndefined();
			expect(h.notice(["bash", "file"])).toContain("web is turned off");
		});

		it(`${label}: a re-enable clears the hold and the notice`, () => {
			const h = held(model, ["bash", "web"]);
			h.apply(["bash", "web"], ["bash"], new Set());
			h.apply(["bash"], ["bash", "web"], new Set());
			expect(h.off.size).toBe(0);
			expect(h.notice(["bash", "web"])).toBeUndefined();
		});

		it(`${label}: the next span drops the hold`, () => {
			const h = held(model, ["bash", "web"]);
			h.beginSpan(undefined);
			h.apply(["bash", "web"], ["bash"], new Set());
			h.beginSpan(undefined);
			expect(h.off.size).toBe(1);
			h.beginSpan("100");
			expect(h.off.size).toBe(0);
		});
	}

	it("names namespace siblings as the alternative", () => {
		const h = held(NONE, ["bash", "mcp__s__a", "mcp__s__b"]);
		h.apply(["bash", "mcp__s__a", "mcp__s__b"], ["bash", "mcp__s__b"], new Set());
		expect(h.refusal("mcp__s__a", ["bash", "mcp__s__b"])).toContain("Use mcp__s__b instead");
	});

	it("none: an enable of an undeclared tool is hidden until the next span; additions declares it at once", () => {
		const h = held(NONE, ["bash"]);
		expect([...h.apply(["bash"], ["bash", "web"], new Set(["x"]))].sort()).toEqual(["web", "x"]);
		h.beginSpan("100");
		expect(h.late.size).toBe(0);
		const a = held(ADDITIONS, ["bash"]);
		expect(a.apply(["bash"], ["bash", "web"], new Set()).size).toBe(0);
	});

	it("none: a tool enabled at startup is declared normally; an MCP server connecting mid-span is held like any tool", () => {
		expect(held(NONE, []).apply([], ["bash", "web"], new Set()).size).toBe(0);
		const h = held(NONE, ["bash"]);
		expect([...h.apply(["bash"], ["bash", "mcp__s__a"], new Set())]).toEqual(["mcp__s__a"]);
		h.beginSpan("100");
		expect(h.apply(["bash", "mcp__s__a"], ["bash", "mcp__s__a"], new Set()).size).toBe(0);
	});

	it("none: a request whose messages hold a new compaction declares the late tools, keeping what hooks hide", () => {
		const h = held(NONE, ["bash"]);
		h.beginSpan(undefined);
		h.apply(["bash"], ["bash", "mcp__s__a"], new Set(["skill"]));
		expect([...h.hiddenIn(undefined)].sort()).toEqual(["mcp__s__a", "skill"]);
		expect([...h.hiddenIn("100")]).toEqual(["skill"]);
	});

	it("changes: nothing is held", () => {
		const h = held(CHANGES, ["bash", "web"]);
		h.apply(["bash", "web"], ["bash"], new Set());
		expect(h.off.size).toBe(0);
		expect(h.apply(["bash"], ["bash", "archive"], new Set()).size).toBe(0);
	});

	it("names the span by the last compaction summary", () => {
		expect(spanOf([{ role: "user" }])).toBeUndefined();
		expect(spanOf([{ role: "compactionSummary", timestamp: 5 }, { role: "user" }])).toBe("5");
	});

	it("sets and removes the tools_off section", () => {
		expect(withToolsOffNotice({ a: "x" }, "n")).toEqual({ a: "x", tools_off: "n" });
		expect(withToolsOffNotice({ a: "x", tools_off: "n" }, undefined)).toEqual({ a: "x" });
	});
});
