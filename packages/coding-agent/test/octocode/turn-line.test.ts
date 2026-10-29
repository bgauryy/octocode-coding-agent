import { afterEach, describe, expect, it, vi } from "vitest";
import { setToolInterruptShown, toolInterruptShown } from "../../src/core/application/interrupted-tools.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { registerTurnLine, TURN_LINE_TYPE, turnLineText } from "../../src/octocode/ui/turn-line.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";

afterEach(() => {
	vi.useRealTimers();
	setToolInterruptShown(false);
});

describe("turn line", () => {
	it("writes the duration and tool count in the one duration format", () => {
		expect(turnLineText({ ms: 62_000, tools: 5 })).toBe("✻ Worked for 1m02s · 5 tools");
		expect(turnLineText({ ms: 4_000, tools: 1 })).toBe("✻ Worked for 4s · 1 tool");
		expect(turnLineText({ ms: 12_000, tools: 0 })).toBe("✻ Worked for 12s");
		expect(turnLineText({ ms: "x" })).toBeUndefined();
		expect(turnLineText(undefined)).toBeUndefined();
	});

	async function run(ms: number, tools: number, options: { hasUI?: boolean } = {}) {
		vi.useFakeTimers({ now: 10_000 });
		const fake = fakeHost();
		registerTurnLine(fake.api);
		const ctx = fakeCtx({ cwd: "/x", ...options });
		await fake.emit("agent_start", {}, ctx);
		for (let index = 0; index < tools; index++)
			await fake.emit("tool_execution_start", { toolCallId: `t${index}` }, ctx);
		await fake.emit("tool_execution_start", { toolCallId: "t/nested", parentToolCallId: "t0" }, ctx);
		vi.setSystemTime(10_000 + ms);
		await fake.emit("agent_end", { messages: [] }, ctx);
		return fake;
	}

	it("appends one entry, outside the model's context, when a run took 3 s or used a tool", async () => {
		expect((await run(62_000, 5)).entries).toEqual([{ customType: TURN_LINE_TYPE, data: { ms: 62_000, tools: 5 } }]);
		expect((await run(1_000, 2)).entries).toHaveLength(1);
		expect((await run(3_000, 0)).entries).toHaveLength(1);
	});

	it("stays quiet for a quick tool-free run and for headless runs", async () => {
		expect((await run(2_900, 0)).entries).toEqual([]);
		expect((await run(60_000, 3, { hasUI: false })).entries).toEqual([]);
	});

	it("draws the entry as one dim line, and nothing for malformed data", async () => {
		initTheme("dark", false);
		const fake = await run(5_000, 2);
		const render = fake.renderers.get(TURN_LINE_TYPE);
		const entry = (data: unknown) => ({ type: "custom", customType: TURN_LINE_TYPE, data });
		expect(rendered(render(entry({ ms: 5_000, tools: 2 }), { expanded: false }, theme))).toBe(
			" ✻ Worked for 5s · 2 tools",
		);
		expect(render(entry({ ms: "bad" }), { expanded: false }, theme)).toBeUndefined();
	});

	it("notes a tool that ended under an interrupt, and forgets it at the next run", async () => {
		const fake = fakeHost();
		registerTurnLine(fake.api);
		const ctx = fakeCtx({ cwd: "/x" });
		const aborted = new AbortController();
		const live = { ...ctx, signal: aborted.signal } as never;
		await fake.emit("agent_start", {}, live);
		await fake.emit("tool_execution_end", { toolCallId: "a", isError: true }, live);
		expect(toolInterruptShown()).toBe(false);
		aborted.abort();
		await fake.emit("tool_execution_end", { toolCallId: "n", parentToolCallId: "a", isError: true }, live);
		expect(toolInterruptShown()).toBe(false);
		await fake.emit("tool_execution_end", { toolCallId: "a", isError: true }, live);
		expect(toolInterruptShown()).toBe(true);
		await fake.emit("agent_start", {}, live);
		expect(toolInterruptShown()).toBe(false);
	});
});
