import { expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
const request = {
	action: "shell" as const,
	title: "Run?",
	what: ["true"],
	toolCallId: "one",
};
function setup() {
	const fake = fakeHost();
	const permission = new Permission({
		api: fake.api,
		env: { OCTOCODE_PERMISSION: "manual" },
		isSubagent: false,
	});
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	permission.start(ctx);
	return { fake, permission, ctx };
}
it("never borrows mismatched, tool-less, or expired execution identity", async () => {
	const { permission, ctx } = setup();
	const resolver = vi.fn(async () => ({ decision: "allow" as const }));
	permission.setResolver(resolver);
	let active = true;
	const invocation = captureToolInvocation("one", "bash", { command: "true" }, () => active)!;
	const copied = { ...ctx, invocation };
	await permission.check(copied, { ...request, toolCallId: "other" });
	await permission.check(copied, { ...request, toolCallId: undefined });
	expect(resolver).not.toHaveBeenCalled();
	expect(await permission.check(copied, request)).toMatchObject({
		allowed: true,
		via: "hook",
		lasts: "call",
	});
	active = false;
	expect(await permission.check(copied, request)).toMatchObject({
		allowed: false,
		via: "headless",
	});
	expect(resolver).toHaveBeenCalledTimes(1);
});
it("records denial before stopping and cancellation wins over late allow", async () => {
	const { permission, ctx, fake } = setup();
	const invocation = captureToolInvocation("one", "bash", {})!;
	const abort = vi.fn(() => {
		expect(fake.entries.at(-1)?.data).toMatchObject({
			allowed: false,
			via: "hook",
		});
	});
	permission.setResolver(async () => ({
		decision: "deny",
		message: "policy",
		interrupt: true,
	}));
	expect(await permission.check({ ...ctx, abort, invocation }, request)).toMatchObject({ allowed: false, via: "hook" });
	expect(abort).toHaveBeenCalledWith("internal");
	const controller = new AbortController();
	permission.setResolver(async () => {
		controller.abort();
		return { decision: "allow" };
	});
	expect(await permission.check({ ...ctx, invocation }, { ...request, signal: controller.signal })).toMatchObject({
		allowed: false,
		via: "cancelled",
	});
});
it("does not authorize an execution that settled while its permission hook waited", async () => {
	const { permission, ctx } = setup();
	let active = true;
	let release!: (value: { decision: "allow" }) => void;
	permission.setResolver(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const invocation = captureToolInvocation("one", "bash", {}, () => active)!;
	const pending = permission.check({ ...ctx, invocation }, request);
	active = false;
	release({ decision: "allow" });
	expect(await pending).toMatchObject({ allowed: false, via: "cancelled" });
});
it("source asks survive full and are answered once per active execution, not once per ID", async () => {
	const { permission, ctx } = setup();
	permission.setMode("full", ctx);
	permission.setSourcePolicy(() => ({ decision: "ask", message: "source" }));
	const resolver = vi.fn(async () => ({ decision: "allow" as const }));
	permission.setResolver(resolver);
	const first = captureToolInvocation("one", "bash", {})!;
	expect(await permission.check({ ...ctx, invocation: first }, request)).toMatchObject({ allowed: true, via: "hook" });
	expect(await permission.check({ ...ctx, invocation: first }, request)).toMatchObject({ allowed: true, via: "mode" });
	expect(resolver).toHaveBeenCalledTimes(1);
	expect(
		await permission.check({ ...ctx, invocation: captureToolInvocation("one", "bash", {})! }, request),
	).toMatchObject({ allowed: true, via: "hook" });
	expect(resolver).toHaveBeenCalledTimes(2);
	permission.setSourcePolicy(() => ({
		decision: "ask",
		message: "changed policy",
	}));
	await permission.check({ ...ctx, invocation: first }, request);
	expect(resolver).toHaveBeenCalledTimes(3);
});
it("refuses applicable source restrictions when SDK arguments cannot be snapshotted", async () => {
	const { permission, ctx } = setup();
	const { permissionGate } = await import("../../src/octocode/permission/gate.ts");
	const { evaluateSourcePolicy, unprojectedSourcePolicy } =
		await import("../../src/octocode/permission/source-policy.ts");
	const { parseSourcePolicy } = await import("../../src/octocode/permission/source-policy/rules.ts");
	const policy = parseSourcePolicy(
		{ permissions: { deny: ["customFoo(flag:true)"] } },
		{ path: "fixture", anchor: ctx.cwd },
	);
	permission.setSourcePolicy(
		(invocation, cwd) => evaluateSourcePolicy(policy, invocation, cwd),
		(name) => unprojectedSourcePolicy(policy, name),
	);
	const gate = permissionGate({
		permission,
		provenance: { check: () => undefined },
	});
	const input: { flag: boolean; self?: unknown } = { flag: true };
	input.self = input;
	expect(await gate({ type: "tool_call", toolCallId: "one", toolName: "customFoo", input }, ctx)).toMatchObject({
		block: true,
	});
});
