import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** The `✻ Worked …` line: one per settled run, however many segments (follow-ups, retries) the run took. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const ALT_ENTER = "\x1b[13;3u"; // kitty encoding
const LINE = /✻ Worked [^\n]*/g;
const lines = async () => ((await t!.text()).match(LINE) ?? []).map((line) => line.trimEnd());
const idle = () => t!.until(() => !t!.host.session.isStreaming, "idle");
const toolTurn = (command: string) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, reason: "a quick command" })], { stopReason: "toolUse" });

describe("turn summary line", () => {
	it("writes one line after a multi-turn tool run", async () => {
		t = await startUi();
		t.script(toolTurn("echo one"), toolTurn("echo two"), "all done");
		await t.type("do two things");
		t.press(KEY.enter);
		await t.until(async () => (await lines()).length > 0, "the summary line");
		await idle();
		expect(await lines()).toEqual([expect.stringMatching(/^✻ Worked \d+s · 2 tools/)]);
		expect(t.requests).toHaveLength(3);
	});

	it("waits for a queued follow-up, then writes one line", async () => {
		t = await startUi();
		const first = hang("first reply");
		const second = hang("follow reply");
		t.script(first, toolTurn("echo follow"), second);
		await t.type("busy");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming && t!.requests.length === 1, "turn to reach the model");
		await t.type("follow me");
		t.press(ALT_ENTER);
		first.release();
		await t.until(() => t!.requests.length === 3, "the follow-up to reach the model");
		expect(await lines()).toEqual([]);
		second.release();
		await t.until(async () => (await lines()).length > 0, "the summary line");
		await idle();
		expect(await lines()).toEqual([expect.stringMatching(/^✻ Worked \d+s · 1 tool(?: · cache \d+%)?$/)]);
	});

	it("keeps a retried run whole, and counts its scripted spend", async () => {
		t = await startUi();
		t.host.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } });
		const session = t.host.session;
		t.script(
			toolTurn("echo one"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
			() => {
				// A request made outside a reply (as a compaction summary is), recorded while the run is on.
				session.sessionManager.appendUsage(
					"side_question",
					"faux",
					"faux-1",
					{
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
					},
					"b44",
				);
				return fauxAssistantMessage("recovered");
			},
		);
		await t.type("go");
		t.press(KEY.enter);
		await t.until(async () => (await lines()).length > 0, "the summary line");
		await idle();
		expect(t.requests).toHaveLength(3);
		expect(await lines()).toEqual([
			expect.stringMatching(/^✻ Worked \d+s · 1 tool · ≈\$0\.50(?: \+ n\/a)? · cache \d+%/),
		]);
	});
});
