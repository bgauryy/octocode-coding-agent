import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentModes } from "../../src/octocode/native/tools/agent/tool.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/** The unified agent tool over a message mode that numbers each delivery and refuses an unknown recipient. */
function unified() {
	const modes = agentModes();
	let next = 0;
	const send = vi.fn(async (_id: string, params: Record<string, unknown>) => {
		if (params.to === "nobody") throw new Error("No agent nobody.");
		next++;
		return {
			content: [{ type: "text" as const, text: `Sent #${next} to ${String(params.to)}.` }],
			details: { id: next },
		};
	});
	modes.collect({
		name: "sendMessage",
		label: "m",
		description: "m",
		parameters: Type.Object({
			to: Type.Optional(Type.String()),
			message: Type.Optional(Type.String()),
			replyRequired: Type.Optional(Type.Boolean()),
		}),
		execute: send,
	});
	const fake = fakeHost();
	modes.register(withNativePermissionOwners(fake.api));
	const tool = fake.tools.get("agent")!;
	const run = (args: Record<string, unknown>) =>
		tool.execute("c", { type: "message", reason: "tell", ...args }, undefined, undefined, fakeCtx({ cwd: "/" }));
	return { run, send };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("\n");

describe("agent message batches", () => {
	it("sends each entry in order, one line each, with top-level fields as defaults", async () => {
		const { run, send } = unified();
		const result = await run({
			replyRequired: true,
			messages: [
				{ to: "kid-a", message: "one" },
				{ to: "kid-b", message: "two", replyRequired: false },
			],
		});
		expect(send.mock.calls.map(([, params]) => params)).toEqual([
			{ to: "kid-a", message: "one", replyRequired: true },
			{ to: "kid-b", message: "two", replyRequired: false },
		]);
		const lines = text(result).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("kid-a");
		expect(lines[1]).toContain("kid-b");
	});

	it("reports a failed entry on its line and still sends the rest", async () => {
		const { run, send } = unified();
		const result = await run({
			messages: [
				{ to: "nobody", message: "lost" },
				{ to: "kid-a", message: "kept", interrupt: true },
				{ to: "kid-b", message: "sent" },
			],
		});
		const lines = text(result).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/error: .*nobody/u);
		// An entry is checked like a lone call: a field the message mode lacks fails that entry only.
		expect(lines[1]).toMatch(/error: .*interrupt/u);
		expect(lines[2]).toContain("kid-b");
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("fails the call when every entry fails, and refuses an empty batch", async () => {
		const { run } = unified();
		await expect(run({ messages: [{ to: "nobody", message: "x" }] })).rejects.toThrow(/nobody/u);
		await expect(run({ messages: [] })).rejects.toThrow(/empty/u);
	});

	it("keeps the single-message form unchanged", async () => {
		const { run, send } = unified();
		const result = await run({ to: "parent", message: "hi" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(text(result)).toBe("Sent #1 to parent.");
		expect(result.details).toMatchObject({ agentType: "message", id: 1 });
	});
});
