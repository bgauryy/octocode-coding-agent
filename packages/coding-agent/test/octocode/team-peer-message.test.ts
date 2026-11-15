import { describe, expect, it } from "vitest";
import type { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

// A message to another Octocode process, through the registered tool's execute path.
function setup() {
	const sent: Array<{ to: string; text: string; options: unknown }> = [];
	const peers = {
		addresses: (to: string) => to.startsWith("octocode-main-"),
		send: async (to: string, text: string, options: unknown) => {
			sent.push({ to, text, options });
			return { text: `Sent to ${to}.`, details: { to: [to] } };
		},
		list: async () => "",
	};
	const team = { members: () => [], join: () => ({ id: "me" }) } as unknown as Team;
	const host = fakeHost();
	registerCollab(host.api, team, { peers });
	const tool = host.tools.get("sendMessage");
	const run = (params: unknown) =>
		tool.execute("call-1", params, undefined, undefined, fakeCtx({ cwd: process.cwd() }));
	return { sent, run, tool };
}
const to = "octocode-main-e2c750e5";

describe("a message to another process", () => {
	it("delivers the text and says a replyTo was ignored", async () => {
		const { sent, run } = setup();
		const result = await run({ to, replyTo: 0, message: "answer" });
		expect(sent).toEqual([{ to, text: "answer", options: {} }]);
		expect(result.content[0].text).toBe(`Sent to ${to}. replyTo was ignored: it reaches teammates only.`);
		expect(result.details).toMatchObject({ replyToIgnored: true });
	});

	it("does not mention replyTo when none was given", async () => {
		const { run } = setup();
		const result = await run({ to, message: "answer", replyRequired: true });
		expect(result.content[0].text).toBe(`Sent to ${to}.`);
	});

	it.each([{ forward: 3 }, { interrupt: true }])("refuses %o, names the fix and sends nothing", async (option) => {
		const { sent, run } = setup();
		await expect(run({ to, message: "answer", ...option })).rejects.toThrow(
			/forward and interrupt reach teammates only\. Nothing was sent; call again without them/,
		);
		expect(sent).toEqual([]);
	});
});
