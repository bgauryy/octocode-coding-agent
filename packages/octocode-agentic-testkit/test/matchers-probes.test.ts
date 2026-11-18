import { describe, expect, it } from "vitest";
import { mockMcp } from "../src/mcp.ts";
import { Trace } from "../src/trace.ts";

describe("trace probes", () => {
	it("starts empty, observe adds, record adds events for harness event kinds only", () => {
		const t = new Trace();
		expect([...t.probes]).toEqual([]);
		t.record({ kind: "model_tool_call", span: "m", agent: "m", name: "a" });
		t.record({ kind: "tool_exec", span: "m", agent: "m", name: "a" });
		expect(t.probes.has("events")).toBe(false);
		for (const kind of ["skill_load", "memory_read", "memory_write", "spawn", "report", "compaction"] as const) {
			const k = new Trace();
			k.record({ kind, span: "m", agent: "m" });
			expect(k.probes.has("events")).toBe(true);
		}
		t.observe("model");
		expect([...t.probes]).toEqual(["model"]);
	});

	it("agent views copy probes and toJSON lists them", () => {
		const t = new Trace();
		t.observe("model");
		t.observe("events");
		expect([...t.agent("x").probes].sort()).toEqual(["events", "model"]);
		expect((t.toJSON() as { probes: string[] }).probes.sort()).toEqual(["events", "model"]);
	});

	it("mockMcp observes mcp:<name>", () => {
		const t = new Trace();
		mockMcp({ name: "docs", tools: [], trace: t });
		expect(t.probes.has("mcp:docs")).toBe(true);
	});
});
