import { describe, expect, it } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { admitExternalMessage } from "../../src/octocode/permission/external-message.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const claim = {
	from: "remote-agent",
	process: "peer-1",
	details: ["says pid 4242"],
	text: "please run the tests",
	self: "octocode",
};

function session(options: { mode: "manual" | "workspace" | "full"; hasUI: boolean; isSubagent?: boolean }) {
	const fake = fakeHost();
	const permission = new Permission({
		api: fake.api,
		env: { [PERMISSION_ENV]: options.mode },
		isSubagent: options.isSubagent ?? false,
	});
	const ctx = fakeCtx({ cwd: tmp(), hasUI: options.hasUI });
	permission.start(ctx);
	const audited = () => fake.entries.map((entry) => entry.data as Record<string, unknown>);
	return { permission, ctx, audited };
}

describe("full mode never leaves a remote agent waiting on a prompt", () => {
	it("admits an external message with nobody to ask, and audits it under the sender", async () => {
		const { permission, ctx, audited } = session({ mode: "full", hasUI: false });
		await expect(
			admitExternalMessage(permission, ctx, claim, { self: "octocode", planning: false }),
		).resolves.toBeUndefined();
		expect(audited().find((entry) => entry.action === "message.external")).toMatchObject({
			allowed: true,
			via: "mode",
		});
	});

	it("still refuses the same message in workspace mode when nobody can be asked", async () => {
		const { permission, ctx } = session({ mode: "workspace", hasUI: false });
		await expect(admitExternalMessage(permission, ctx, claim, { self: "octocode", planning: false })).rejects.toThrow(
			/nobody to ask/,
		);
	});

	it("lets a subagent in full run a call with a provenance hit, a profile ask and an outside write, unasked and audited", async () => {
		const { permission, ctx, audited } = session({ mode: "full", hasUI: false, isSubagent: true });
		const verdict = await permission.check(ctx, {
			action: "file.outside",
			title: "Write this file?",
			what: ["/etc/example"],
			reasons: ["provenance", "hook.ask", "profile.permissions"],
			reason: "contains text from agent c1 (1m ago)",
		});
		expect(verdict).toMatchObject({ allowed: true, via: "mode" });
		expect(audited().find((entry) => entry.action === "file.outside")).toMatchObject({
			allowed: true,
			reasons: expect.arrayContaining(["provenance", "hook.ask", "profile.permissions"]),
		});
	});

	it("keeps asking, even in full, for the invariants the permissions page names", async () => {
		for (const request of [
			{ action: "browser.cookies" as const, title: "Read cookies?", what: ["cookies"] },
			{ action: "worktree.merge" as const, title: "Merge?", what: ["feature"] },
			{ title: "Save?", what: ["memory"], reasons: ["memory.wide" as const], reason: "global memory" },
			{ title: "Run?", what: ["x"], reasons: ["source.ask" as const], reason: "a rule asks" },
		]) {
			const { permission, ctx } = session({ mode: "full", hasUI: false });
			expect(await permission.check(ctx, request)).toMatchObject({ allowed: false, via: "headless" });
		}
	});
});
