import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentModes } from "../../src/octocode/agent-tool.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";

/** The real unified tool over a fake task mode that records when each spawn starts and ends. */
function unified() {
	const modes = agentModes();
	const log: { id: string; input: Record<string, unknown>; start: number; end: number }[] = [];
	const tick = { now: 0 };
	const task = {
		name: "agent",
		label: "task",
		description: "task",
		parameters: Type.Object({
			goal: Type.String(),
			task: Type.String(),
			background: Type.Optional(Type.Boolean()),
			profile: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
		}),
		async execute(id: string, input: Record<string, unknown>) {
			const entry = { id, input, start: tick.now++, end: -1 };
			log.push(entry);
			await new Promise((resolve) => setTimeout(resolve, input.background ? 0 : 20));
			entry.end = tick.now++;
			return {
				content: [{ type: "text" as const, text: input.background ? `Started kid-${id}` : `report for ${input.goal}` }],
				details: {
					id,
					...(input.task === "fails" ? { outcome: "failed" } : input.task === "ends" ? { outcome: "done" } : {}),
				},
			};
		},
	};
	modes.collect(task as never);
	modes.collect({
		name: "coordinate",
		label: "c",
		description: "c",
		parameters: Type.Object({ action: Type.String() }),
		execute: async () => ({ content: [], details: {} }),
	} as never);
	const fake = fakeHost();
	modes.register(withNativePermissionOwners(fake.api));
	const tool = fake.tools.get("agent")!;
	const run = (params: Record<string, unknown>) =>
		tool.execute("call1", { reason: "batch", ...params }, undefined, undefined, fakeCtx({ cwd: process.cwd() }));
	return { tool, run, log };
}

const text = (result: { content: { text: string }[] }) => result.content.map((part) => part.text).join("\n");

describe("agent task batch", () => {
	it("starts background entries concurrently and lists both ids", async () => {
		const { run, log } = unified();
		const result = await run({
			type: "task",
			background: true,
			tasks: [
				{ goal: "one", task: "a" },
				{ goal: "two", task: "b" },
			],
		});
		expect(log).toHaveLength(2);
		expect(log[1].start).toBeLessThan(log[0].end);
		expect(text(result)).toContain("Started kid-call1#1");
		expect(text(result)).toContain("Started kid-call1#2");
		expect(result.details.agentType).toBe("task");
		expect(result.details.batch).toHaveLength(2);
	});

	it("returns an invalid entry's error while the other starts", async () => {
		const { run, log } = unified();
		const result = await run({ type: "task", tasks: [{ goal: "fine", task: "a" }, { goal: "no brief" }] });
		expect(log.map((entry) => entry.id)).toEqual(["call1#1"]);
		const out = text(result);
		expect(out).toContain("#1 ok: fine");
		expect(out).toContain("#2 error: no brief");
		expect(out).toContain("Invalid agent task call");
		expect(result.details.batch.map((entry: { ok: boolean }) => entry.ok)).toEqual([true, false]);
	});

	it("labels a row by the child's outcome, so a child that ran and failed does not read ok", async () => {
		const { run } = unified();
		const result = await run({
			type: "task",
			tasks: [
				{ goal: "broke", task: "fails" },
				{ goal: "finished", task: "ends" },
			],
		});
		const out = text(result);
		expect(out).toContain("#1 failed: broke");
		expect(out).toContain("#2 ok: finished");
		expect(result.details.batch.map((entry: { ok: boolean }) => entry.ok)).toEqual([true, true]);
	});

	it("waits for every foreground entry", async () => {
		const { run, log } = unified();
		const result = await run({
			type: "task",
			tasks: [
				{ goal: "x", task: "a" },
				{ goal: "y", task: "b" },
			],
		});
		expect(log.every((entry) => entry.end >= 0)).toBe(true);
		expect(log[1].start).toBeLessThan(log[0].end);
		expect(text(result)).toContain("report for x");
		expect(text(result)).toContain("report for y");
	});

	it("applies top-level defaults and lets an entry win", async () => {
		const { run, log } = unified();
		await run({
			type: "task",
			profile: "scout",
			task: "shared brief",
			background: true,
			tasks: [{ goal: "a" }, { goal: "b", profile: "coder", task: "own brief" }],
		});
		expect(log[0].input).toMatchObject({ profile: "scout", task: "shared brief", background: true, reason: "batch" });
		expect(log[1].input).toMatchObject({ profile: "coder", task: "own brief" });
	});

	it("refuses tasks on another type and an unknown entry field", async () => {
		const { run, log } = unified();
		await expect(run({ type: "coordinate", action: "list", tasks: [{ goal: "a" }] })).rejects.toThrow(
			"does not take tasks (only for task)",
		);
		await expect(run({ type: "task", tasks: [{ goal: "a", task: "b", bogus: 1 }] })).rejects.toThrow(
			"does not take bogus",
		);
		expect(log).toHaveLength(0);
	});

	it("renders the batch as a list of goals", () => {
		const { tool } = unified();
		const row = tool.renderCall({ type: "task", task: "t", tasks: [{ goal: "one" }, { goal: "two" }] }, theme, {});
		expect(rendered(row)).toMatch(/×2\n\s+1\. one\n\s+2\. two/);
	});
});
