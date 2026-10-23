import path from "node:path";
import { expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { octocodeHome } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

function setup(target: string, allowed = false) {
	const fake = fakePi();
	const permission = new Permission({
		pi: fake.pi,
		env: { OCTOCODE_PERMISSION: "manual" },
		isSubagent: false,
	});
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	permission.start(ctx);
	permission.setSourcePolicy(() => ({
		decision: "allow",
		shellTargets: [
			{ kind: "write", path: target, raw: target, position: 0, allowed },
		],
	}));
	const invocation = captureToolInvocation("shell-one", "bash", {
		command: `printf x > ${target}`,
	})!;
	const request = {
		action: "shell" as const,
		title: "Run?",
		what: ["original command"],
		toolCallId: invocation.toolCallId,
		invocation,
	};
	return { permission, ctx, request };
}
it("does not let a Bash grant cover an unresolved target at the shared check owner", async () => {
	const { permission, ctx, request } = setup(path.join(tmp(), "out"));
	expect(await permission.check(ctx, request)).toMatchObject({
		allowed: false,
		via: "headless",
	});
});
it("uses one original invocation resolver for all target classes", async () => {
	const { permission, ctx, request } = setup(path.join(tmp(), "out"));
	const resolver = vi.fn(async (..._args: unknown[]) => ({
		decision: "allow" as const,
	}));
	permission.setResolver(resolver);
	expect(await permission.check(ctx, request)).toMatchObject({
		allowed: true,
		via: "hook",
	});
	expect(resolver).toHaveBeenCalledTimes(1);
	expect(resolver.mock.calls[0]?.[1]).toBe(request.invocation);
});
it("refuses state-folder writes before any hook even in full mode", async () => {
	const { permission, ctx, request } = setup(
		path.join(octocodeHome(), "trust.json"),
		true,
	);
	permission.setMode("full", ctx);
	const resolver = vi.fn(async (..._args: unknown[]) => ({
		decision: "allow" as const,
	}));
	permission.setResolver(resolver);
	expect(await permission.check(ctx, request)).toMatchObject({
		allowed: false,
		via: "policy",
	});
	expect(resolver).not.toHaveBeenCalled();
});
it("checks targets on user-authored requests without a primary action", async () => {
	const { permission, ctx, request } = setup(path.join(tmp(), "out"));
	expect(
		await permission.check(ctx, { ...request, action: undefined }),
	).toMatchObject({ allowed: false, via: "headless" });
});
it("retains an explicit broad Bash allowance for ordinary outside targets", async () => {
	const target = path.join(tmp(), "outside");
	const { permission, ctx, request } = setup(target);
	permission.setSourcePolicy(() => ({
		decision: "allow",
		shellBroadAllowance: true,
		shellTargets: [
			{ kind: "write", path: target, raw: target, position: 0, allowed: false },
		],
	}));
	expect(await permission.check(ctx, request)).toMatchObject({
		allowed: true,
		via: "policy",
	});
});
it.each(["manual", "workspace", "full"] as const)(
	"keeps unresolved targets explicit in %s mode",
	async (mode) => {
		const { permission, ctx, request } = setup("unknown");
		permission.setMode(mode, ctx);
		permission.setSourcePolicy(() => ({
			decision: "allow",
			shellBroadAllowance: true,
			shellTargets: [
				{
					kind: "write",
					raw: "$FILE",
					uncertain: "dynamic target",
					position: 0,
					allowed: false,
				},
			],
		}));
		expect((await permission.check(ctx, request)).allowed).toBe(
			mode === "full",
		);
	},
);
