import { expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { parsePermissionUpdates } from "../../src/octocode/shared/permission-updates.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
const updates = parsePermissionUpdates([
	{
		type: "addRules",
		rules: [{ toolName: "Bash" }],
		behavior: "deny",
		destination: "session",
	},
]);
function setup() {
	const fake = fakePi();
	const permission = new Permission({
		pi: fake.pi,
		env: { OCTOCODE_PERMISSION: "manual" },
		isSubagent: false,
	});
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	permission.start(ctx);
	const invocation = captureToolInvocation("one", "bash", { command: "true" })!;
	const request = {
		action: "shell" as const,
		title: "Run?",
		what: ["true"],
		toolCallId: "one",
		invocation,
	};
	return { fake, permission, ctx, request };
}
it("publishes after approval without applying its own new denial to that call", async () => {
	const f = setup();
	const publish = vi.fn(() =>
		f.permission.setSourcePolicy(() => ({
			decision: "deny",
			message: "next only",
		})),
	);
	f.permission.setUpdateHandler(async () => (_signal, commit) => commit(publish));
	f.permission.setResolver(async () => ({
		decision: "allow",
		updatedPermissions: updates,
	}));
	expect(await f.permission.check(f.ctx, f.request)).toMatchObject({
		allowed: true,
		via: "hook",
	});
	expect(publish).toHaveBeenCalledTimes(1);
	expect(
		await f.permission.check(f.ctx, {
			...f.request,
			invocation: captureToolInvocation("one", "bash", { command: "true" })!,
		}),
	).toMatchObject({ allowed: false, via: "policy" });
	expect(JSON.stringify(f.fake.entries)).toContain("applied updates");
});
it("invalidates another pending approval while preserving the exact publisher", async () => {
	const f = setup();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.permission.setResolver(async (_ctx, invocation) => {
		if (invocation.toolCallId === "pending") {
			await held;
			return { decision: "allow" };
		}
		return { decision: "allow", updatedPermissions: updates };
	});
	f.permission.setUpdateHandler(
		async () => (_signal, commit) => commit(() => f.permission.setSourcePolicy(() => ({ decision: "deny" }))),
	);
	const pending = f.permission.check(f.ctx, {
		...f.request,
		toolCallId: "pending",
		invocation: captureToolInvocation("pending", "bash", { command: "true" })!,
	});
	expect(await f.permission.check(f.ctx, f.request)).toMatchObject({
		allowed: true,
	});
	release();
	expect(await pending).toMatchObject({ allowed: false, via: "cancelled" });
});
it("never publishes after cancellation during preparation", async () => {
	const f = setup();
	const abort = new AbortController();
	const publish = vi.fn();
	f.permission.setResolver(async () => ({
		decision: "allow",
		updatedPermissions: updates,
	}));
	f.permission.setUpdateHandler(async () => {
		abort.abort();
		return publish;
	});
	expect(await f.permission.check(f.ctx, { ...f.request, signal: abort.signal })).toMatchObject({
		allowed: false,
		via: "cancelled",
	});
	expect(publish).not.toHaveBeenCalled();
});
it("does not prepare or publish updates after a rejected replacement", async () => {
	const f = setup();
	const prepare = vi.fn(async () => vi.fn());
	f.permission.setUpdateHandler(prepare);
	f.permission.setResolver(async () => ({
		decision: "allow",
		updatedInput: { command: "candidate" },
		updatedPermissions: updates,
	}));
	expect(
		await f.permission.checkWithReplacement(f.ctx, f.request, async () => {
			throw new Error("invalid candidate");
		}),
	).toMatchObject({ allowed: false, via: "policy" });
	expect(prepare).not.toHaveBeenCalled();
});
