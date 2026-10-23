import { expect, it } from "vitest";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { Type } from "typebox";

it("provides immutable execution identity on a fresh context and revokes it after completion", async () => {
	const supplied = {} as ExtensionToolContext;
	let captured: any;
	let copied: any;
	const params = { nested: { value: "original" } };
	const tool = wrapToolDefinition({
		name: "probe",
		label: "probe",
		description: "probe",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, _update, ctx) => {
			captured = ctx;
			copied = { ...ctx };
			expect(ctx).not.toBe(supplied);
			expect((ctx as any).invocation).toEqual({
				toolCallId: "call",
				toolName: "probe",
				input: params,
			});
			params.nested.value = "changed";
			expect((ctx as any).invocation.input.nested.value).toBe("original");
			expect(Object.isFrozen((ctx as any).invocation.input.nested)).toBe(true);
			return { content: [], details: {} };
		},
	});
	await (tool.execute as any)("call", params, undefined, undefined, supplied);
	expect(captured.invocation).toBeUndefined();
	expect(copied.invocation.active).toBe(false);
	expect((supplied as any).invocation).toBeUndefined();
});

it("isolates parallel and nested calls and revokes identity on rejection", async () => {
	const contexts: any[] = [];
	const releases: Array<() => void> = [];
	const tool = wrapToolDefinition(
		{
			name: "probe",
			label: "probe",
			description: "probe",
			parameters: Type.Object({}),
			execute: async (id, _params, _signal, _update, ctx) => {
				contexts.push(ctx);
				await new Promise<void>((resolve) => releases.push(resolve));
				expect((ctx as any).invocation.toolCallId).toBe(id);
				throw new Error("expected");
			},
		},
		() => ({}) as ExtensionToolContext,
	);
	const a = tool.execute("a", {}, undefined).catch(() => undefined),
		b = tool.execute("a/1", {}, undefined).catch(() => undefined);
	expect(contexts.map((ctx) => ctx.invocation?.toolCallId)).toEqual([
		"a",
		"a/1",
	]);
	releases.forEach((resolve) => resolve());
	await Promise.all([a, b]);
	expect(contexts.map((ctx) => ctx.invocation)).toEqual([undefined, undefined]);
});

it.each(["cycle", "typed", "function", "deep"])(
	"preserves SDK execution with unsupported %s snapshot input",
	async (kind) => {
		const input: any =
			kind === "typed"
				? new Uint8Array([1])
				: kind === "function"
					? { callback: () => 1 }
					: {};
		if (kind === "cycle") input.self = input;
		if (kind === "deep") {
			let next = input;
			for (let i = 0; i < 100; i++) next = next.child = {};
		}
		let called = false;
		const tool = wrapToolDefinition(
			{
				name: "custom",
				label: "custom",
				description: "custom",
				parameters: Type.Any(),
				execute: async (_id, args, _signal, _update, ctx) => {
					called = true;
					expect(args).toBe(input);
					expect((ctx as any).invocation).toBeUndefined();
					return { content: [], details: {} };
				},
			},
			() => ({}) as ExtensionToolContext,
		);
		await tool.execute("custom", input, undefined);
		expect(called).toBe(true);
	},
);
