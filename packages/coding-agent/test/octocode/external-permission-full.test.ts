import { describe, expect, it } from "vitest";
import { externalPermission } from "../../src/octocode/external/permission-dialog.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const request = {
	sessionId: "external-session",
	toolCall: { toolCallId: "external-call", title: "Run external task" },
	options: [
		{ optionId: "forever", name: "Always", kind: "allow_always" as const },
		{ optionId: "one", name: "Proceed", kind: "allow_once" as const },
		{ optionId: "no", name: "Stop", kind: "reject_once" as const },
	],
};

function setup(mode: string, hasUI: boolean) {
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd: tmp(), hasUI, ui: { selects: [] } });
	permission.start(ctx);
	return { permission, ctx, fake, decide: externalPermission(permission)(ctx) };
}

describe("an outbound external ACP agent's permission request", () => {
	it("is allowed once without a prompt in full mode, with nobody to ask, and audited", async () => {
		const { decide, ctx, fake } = setup("full", false);
		await expect(decide(request, new AbortController().signal)).resolves.toEqual({
			outcome: { outcome: "selected", optionId: "one" },
		});
		expect(ctx.ui.selects).toEqual([]);
		expect(fake.entries.map((entry) => entry.data)).toEqual([
			expect.objectContaining({ action: "agent.spawn", allowed: true, via: "mode", mode: "full" }),
		]);
	});

	it("never picks an always-allow option: a request offering only reject or allow_always is left to the dialog", async () => {
		const { decide, fake } = setup("full", false);
		const decision = await decide(
			{ ...request, options: request.options.filter((option) => option.kind !== "allow_once") },
			new AbortController().signal,
		);
		expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
		expect(fake.entries).toEqual([]);
	});

	it("answers like full in bypass", async () => {
		const { decide } = setup("bypass", false);
		await expect(decide(request, new AbortController().signal)).resolves.toEqual({
			outcome: { outcome: "selected", optionId: "one" },
		});
	});

	it("still goes to the person outside full mode, and is refused when none can be asked", async () => {
		const { decide, fake } = setup("workspace", false);
		await expect(decide(request, new AbortController().signal)).resolves.toEqual({
			outcome: { outcome: "selected", optionId: "no" },
		});
		expect(fake.entries).toEqual([]);
	});
});
