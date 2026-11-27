import { describe, expect, it, vi } from "vitest";
import { hasUserAuthority, inputOrigin, withInputOrigin } from "../../src/core/input-origin.ts";
import { messagePolicy } from "../../src/octocode/message-policy.ts";
import { userBashGate } from "../../src/octocode/permission/user-bash.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const event = { type: "user_bash" as const, command: "printf hello", excludeFromContext: false, cwd: "/" };

describe("only the terminal carries the user's authority", () => {
	it("is the terminal unless the input says otherwise, and the origin follows the awaited work", async () => {
		expect(inputOrigin()).toBe("terminal");
		expect(hasUserAuthority()).toBe(true);
		await withInputOrigin("web", async () => {
			await Promise.resolve();
			expect(inputOrigin()).toBe("web");
			expect(hasUserAuthority()).toBe(false);
		});
		expect(inputOrigin()).toBe("terminal");
	});

	it.each(["acp", "web", "rpc"] as const)(
		"a %s `!cmd` is judged like an agent's call, never typed consent",
		async (origin) => {
			const typed = vi.fn();
			const check = vi.fn(async () => ({ block: true, reason: "declined in the client" }));
			const gate = userBashGate({
				clientPermission: check,
				permission: { check: vi.fn(), refused: vi.fn(), typed, sourceDecision: () => undefined },
				preToolUse: async () => undefined,
			});
			const result = await withInputOrigin(origin, () => gate(event, fakeCtx({ cwd: "/work" })));
			expect(typed).not.toHaveBeenCalled();
			expect(check).toHaveBeenCalledTimes(1);
			expect(result?.result?.output).toContain("Refused: declined in the client");
		},
	);

	it("a terminal `!cmd` is still consent by typing", async () => {
		const typed = vi.fn();
		const check = vi.fn();
		const gate = userBashGate({
			clientPermission: check,
			permission: { check, refused: vi.fn(), typed, sourceDecision: () => undefined },
			preToolUse: async () => undefined,
		});
		expect(await gate(event, fakeCtx({ cwd: "/work" }))).toBeUndefined();
		expect(typed).toHaveBeenCalledTimes(1);
		expect(check).not.toHaveBeenCalled();
	});

	it("a `!cmd` a hook blocks stays refused whatever the origin", async () => {
		const refused = vi.fn();
		const gate = userBashGate({
			clientPermission: vi.fn(),
			permission: { check: vi.fn(), refused, typed: vi.fn(), sourceDecision: () => undefined },
			preToolUse: async () => ({ block: true, reason: "no" }),
		});
		const result = await withInputOrigin("acp", () => gate(event, fakeCtx({ cwd: "/work" })));
		expect(result?.result?.output).toContain("Refused: no");
		expect(refused).toHaveBeenCalled();
	});

	function widening(hasUI: boolean, answer: boolean) {
		const permission = fakePermission("manual");
		const ctx = fakeCtx({ cwd: tmp(), hasUI });
		const confirm = vi.fn(async () => answer);
		ctx.ui.confirm = confirm;
		return { permission, ctx, confirm };
	}

	it("a permission change from the terminal needs no client confirmation", async () => {
		const { permission, ctx, confirm } = widening(true, false);
		expect(await permission.chooseMode("full", ctx)).toBe(true);
		expect(permission.mode).toBe("full");
		expect(confirm).not.toHaveBeenCalled();
	});

	it.each(["acp", "web"] as const)(
		"widening the mode from %s asks that client and keeps the mode when declined",
		async (origin) => {
			const { permission, ctx, confirm } = widening(true, false);
			expect(await withInputOrigin(origin, () => permission.chooseMode("full", ctx))).toBe(false);
			expect(permission.mode).toBe("manual");
			expect(confirm).toHaveBeenCalledTimes(1);
		},
	);

	it("widening the mode from a client with no dialog is refused", async () => {
		const { permission, ctx, confirm } = widening(false, true);
		expect(await withInputOrigin("acp", () => permission.chooseMode("full", ctx))).toBe(false);
		expect(permission.mode).toBe("manual");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("widening the mode from a client applies once that client approves", async () => {
		const { permission, ctx, confirm } = widening(true, true);
		expect(await withInputOrigin("web", () => permission.chooseMode("workspace", ctx))).toBe(true);
		expect(permission.mode).toBe("workspace");
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	function merging() {
		const f = fakeHost();
		const permission = fakePermission("manual", { api: f.api });
		const typed = vi.spyOn(permission, "typed");
		const messaging = messagePolicy({
			api: f.api,
			hooks: {} as never,
			permission,
			planning: { blocked: () => false },
			provenance: {} as never,
			team: { reservation: () => undefined, members: () => [] },
		});
		return { messaging, typed, ctx: fakeCtx({ cwd: tmp(), hasUI: true }) };
	}

	it("a typed `/worktree merge` is consent only at the terminal", async () => {
		const terminal = merging();
		// The folder is no repository, so the merge itself fails after the consent step; only the consent is observed.
		await terminal.messaging.typedMerge("feature", terminal.ctx).catch(() => undefined);
		expect(terminal.typed).toHaveBeenCalledTimes(1);
		for (const origin of ["acp", "web"] as const) {
			const client = merging();
			await withInputOrigin(origin, () => client.messaging.typedMerge("feature", client.ctx)).catch(() => undefined);
			expect(client.typed).not.toHaveBeenCalled();
		}
	});
});
