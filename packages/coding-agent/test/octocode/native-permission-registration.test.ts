import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { userBashGate } from "../../src/octocode/permission/user-bash.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";

it("rejects an unreviewed native registration before activation, even with a read-only annotation", () => {
	const fake = fakePi();
	const pi = withNativePermissionOwners(fake.pi);
	const tool = {
		name: "newNativeTool",
		label: "New tool",
		description: "Test",
		annotations: { readOnlyHint: true },
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
	expect(() => pi.registerTool(tool)).toThrow("has no permission owner");
	expect(fake.tools.size).toBe(0);
	pi.registerTool({ ...tool, name: "file" });
	expect(() => pi.registerTool({ ...tool, name: "mcp__octocode__localFetch" })).toThrow("has no permission owner");
	expect([...fake.tools.keys()]).toEqual(["file"]);
});

it("user Bash calls carry explicit origin and independent opaque invocation IDs", async () => {
	const preToolUse = vi.fn(async (_event: ToolCallEvent) => undefined);
	const typed = vi.fn();
	const gate = userBashGate({
		permission: { check: vi.fn(), refused: vi.fn(), typed, hasSourcePolicy: false },
		preToolUse,
	});
	const event = { type: "user_bash" as const, command: "printf hello", excludeFromContext: false, cwd: "/" };
	await gate(event, fakeCtx({ cwd: "/work" }));
	await gate(event, fakeCtx({ cwd: "/work" }));
	const first = preToolUse.mock.calls[0][0];
	const second = preToolUse.mock.calls[1][0];
	expect(first).toMatchObject({ origin: "user", toolName: "bash" });
	expect(first.toolCallId).not.toBe(second.toolCallId);
	expect(first.toolCallId).not.toBe("user-bash");
	expect(typed).toHaveBeenCalledTimes(2);
});
