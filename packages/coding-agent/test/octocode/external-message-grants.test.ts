import { describe, expect, it } from "vitest";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE, DENY, sessionOption } from "../../src/octocode/permission/ask/text.ts";
import { admitExternalMessage } from "../../src/octocode/permission/external-message.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const ALL = sessionOption("all external messages");
const fromProcess = (name: string) => sessionOption(`messages from ${name}`);
const claimFrom = (name: string) => ({
	from: name,
	process: { id: `oc-${name}#1`, name },
	details: [],
	text: "please look",
});

/** A manual (or full) session whose dialog is answered from `answers` in order; `asked` keeps each dialog's title and choices. */
function receiver(mode: "manual" | "full", answers: string[]) {
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
	const asked: { title: string; choices: string[] }[] = [];
	ctx.ui.select = async (title: string, choices: string[]) => {
		asked.push({ title, choices });
		return answers.shift();
	};
	permission.start(ctx);
	const admit = (name: string, planning = false) =>
		admitExternalMessage(permission, ctx, claimFrom(name), { self: "octocode", planning });
	return { permission, admit, asked };
}

describe("a message from a process, in manual mode", () => {
	it("a process grant admits that process alone, and clearing the message grants asks again", async () => {
		const { permission, admit, asked } = receiver("manual", [fromProcess("alpha"), DENY, ALLOW_ONCE]);
		await expect(admit("alpha")).resolves.toBeUndefined();
		await expect(admit("alpha")).resolves.toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(permission.grants()).toContain("message.external: messages from alpha");

		await expect(admit("beta")).rejects.toThrow("denied this message");
		expect(asked).toHaveLength(2);

		expect(permission.clearMessageGrants()).toBe(1);
		await expect(admit("alpha")).resolves.toBeUndefined();
		expect(asked).toHaveLength(3);
	});

	it("the all-processes grant admits every process for this session", async () => {
		const { admit, asked } = receiver("manual", [ALL]);
		await expect(admit("alpha")).resolves.toBeUndefined();
		await expect(admit("beta")).resolves.toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(asked[0].choices).toEqual(expect.arrayContaining([ALLOW_ONCE, fromProcess("alpha"), ALL, DENY]));
	});
});

describe("a session in plan", () => {
	it("asks in full with the same choices, where full otherwise takes the message", async () => {
		const { admit, asked } = receiver("full", [ALLOW_ONCE]);
		await expect(admit("alpha")).resolves.toBeUndefined();
		expect(asked).toHaveLength(0);

		await expect(admit("alpha", true)).resolves.toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(asked[0].choices).toEqual(expect.arrayContaining([ALLOW_ONCE, fromProcess("alpha"), ALL, DENY]));
	});
});
