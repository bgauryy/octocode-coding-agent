import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ToolInvocation, ToolCallEvent } from "../../src/core/extensions/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
const definition = {
	name: "bash",
	description: "test",
	parameters: Type.Object({
		command: Type.String(),
		timeout: Type.Optional(Type.Number()),
		background: Type.Optional(Type.Boolean()),
	}),
};
function setup(
	updatedInput: unknown,
	provenance: { check: (event: any) => { why: string } | undefined } = { check: () => undefined },
) {
	const fake = fakePi();
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const permission = new Permission({
		pi: fake.pi,
		env: { OCTOCODE_PERMISSION: "manual" },
		isSubagent: false,
	});
	permission.start(ctx);
	const resolver = vi.fn(async (_ctx: unknown, _invocation: ToolInvocation) => ({
		decision: "allow" as const,
		updatedInput: updatedInput as any,
	}));
	permission.setResolver(resolver);
	const refresh = vi.fn(async () => {});
	const reserved = vi.fn(async () => undefined as { block: true; reason: string } | undefined);
	const gate = permissionGate({
		permission,
		provenance,
		replacement: { definition: () => definition, refresh, reserved },
	});
	const event = {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "one",
		input: { command: "printf original", timeout: 30, background: true },
	} as ToolCallEvent & { input: Record<string, unknown> };
	return { fake, ctx, permission, resolver, refresh, reserved, gate, event };
}
it("validates, rechecks and commits effective source input without old native options", async () => {
	const f = setup({
		command: "printf replacement",
		timeout: 120,
		description: "source advisory",
		background: true,
		type: "powershell",
	});
	expect(await f.gate(f.event, f.ctx)).toBeUndefined();
	expect(f.event.input).toEqual({
		command: "printf replacement",
		timeout: 0.12,
		description: "source advisory",
	});
	expect(f.resolver).toHaveBeenCalledTimes(1);
	expect(f.refresh).toHaveBeenCalledTimes(2);
	expect(f.reserved).toHaveBeenCalledTimes(2);
	expect(f.resolver.mock.calls[0][1].input).toEqual({
		command: "printf original",
		timeout: 30,
		background: true,
	});
	const entries = f.fake.entries.filter((entry) => (entry.data as any)?.allowed === true);
	expect(entries).toHaveLength(1);
	expect(JSON.stringify(entries[0])).toContain("replacement");
});
it("does not interpret a model's tool-call ID as the user origin", async () => {
	const f = setup({ command: "printf replacement" });
	f.event.toolCallId = "user-bash";
	f.event.origin = "model";
	expect(await f.gate(f.event, f.ctx)).toBeUndefined();
	expect(f.event.input.command).toBe("printf replacement");
});
it("blocks user command replacement using origin regardless of invocation ID", async () => {
	const f = setup({ command: "printf replacement" });
	f.event.origin = "user";
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.event.input.command).toBe("printf original");
});
it.each([{ command: 7 }, null, "wrong"])("never executes original for invalid replacement %j", async (input) => {
	const f = setup(input);
	const original = structuredClone(f.event.input);
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.event.input).toEqual(original);
});
it("preserves empty replacement input but rechecks a source ask without a second hook", async () => {
	const f = setup({});
	f.permission.setSourcePolicy(() => ({
		decision: "ask",
		message: "source asks",
	}));
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.resolver).toHaveBeenCalledTimes(1);
	expect(f.event.input.command).toBe("printf original");
});
it("does not let a hook approval carry a replacement that trips provenance", async () => {
	// The hook approved the original command; its replacement reads as untrusted-content driven, which needs a person.
	const f = setup(
		{ command: "printf replacement" },
		{
			check: (event) =>
				String(event.input?.command).includes("replacement") ? { why: "untrusted content asked for this" } : undefined,
		},
	);
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.resolver).toHaveBeenCalledTimes(1);
	expect(f.event.input.command).toBe("printf original");
});
it("observes source policy changed while hook ran", async () => {
	const f = setup({ command: "printf replacement" });
	let denied = false;
	f.permission.setSourcePolicy(() => (denied ? { decision: "deny", message: "new deny" } : { decision: "none" }));
	f.refresh.mockImplementation(async () => {
		denied = true;
	});
	expect(await f.gate(f.event, f.ctx)).toMatchObject({
		block: true,
		reason: "new deny",
	});
	expect(f.event.input.command).toBe("printf original");
});
it("rechecks reservations before commit and retains original on refusal", async () => {
	const f = setup({ command: "printf replacement" });
	f.reserved.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ block: true, reason: "reserved now" });
	expect(await f.gate(f.event, f.ctx)).toMatchObject({
		block: true,
		reason: "reserved now",
	});
	expect(f.event.input.command).toBe("printf original");
});
it("does not commit when cancellation occurs during final refresh", async () => {
	const f = setup({ command: "printf replacement" });
	const controller = new AbortController();
	f.ctx.signal = controller.signal;
	f.refresh
		.mockImplementationOnce(async () => {})
		.mockImplementationOnce(async () => {
			controller.abort();
		});
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.event.input.command).toBe("printf original");
});
it("does not accept a rewrite at an inner permission request without a transaction", async () => {
	const f = setup({ command: "printf replacement" });
	expect(
		await f.permission.check(f.ctx, {
			action: "shell",
			title: "Run?",
			what: ["original"],
			invocation: captureToolInvocation("one", "bash", { command: "original" }),
		}),
	).toMatchObject({ allowed: false });
});
it("does not change PowerShell syntax through Claude replacement", async () => {
	const f = setup({ command: "printf replacement" });
	Object.assign(f.event.input, { type: "powershell" });
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.event.input).toHaveProperty("type", "powershell");
});

it("does not commit if policy lifetime expires inside final refresh", async () => {
	const f = setup({ command: "printf replacement" });
	f.refresh
		.mockImplementationOnce(async () => {})
		.mockImplementationOnce(async () => {
			f.permission.setMode("workspace", f.ctx);
		});
	expect(await f.gate(f.event, f.ctx)).toMatchObject({ block: true });
	expect(f.event.input.command).toBe("printf original");
});
it("fresh source ask during final validation cannot inherit the earlier hook approval", async () => {
	const f = setup({ command: "printf replacement" });
	let ask = false;
	f.permission.setSourcePolicy(() => ({
		decision: ask ? "ask" : "none",
		message: "new ask",
	}));
	f.refresh
		.mockImplementationOnce(async () => {})
		.mockImplementationOnce(async () => {
			ask = true;
		});
	expect(await f.gate(f.event, f.ctx)).toMatchObject({
		block: true,
		reason: "new ask",
	});
	expect(f.event.input.command).toBe("printf original");
});

it("does not commit policy changed during final reservation validation", async () => {
	const f = setup({ command: "printf replacement" });
	let denied = false;
	f.permission.setSourcePolicy(() => ({
		decision: denied ? "deny" : "none",
		message: "late deny",
	}));
	f.reserved
		.mockImplementationOnce(async () => undefined)
		.mockImplementationOnce(async () => {
			denied = true;
			return undefined;
		});
	expect(await f.gate(f.event, f.ctx)).toMatchObject({
		block: true,
		reason: "late deny",
	});
	expect(f.event.input.command).toBe("printf original");
});
