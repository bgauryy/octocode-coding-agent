import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** `/quit` through the real interactive host: it stops background work, so it asks first. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const shows = (text: string) => async () => (await t!.text()).includes(text);
const quit = async () => {
	await t!.type("/quit");
	t!.press(KEY.enter);
};

describe("/quit with running work", () => {
	it("asks before stopping a background job; declining keeps the session and says so, accepting quits", async () => {
		t = await startUi();
		t.script(
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60", reason: "a long job", background: true })], {
				stopReason: "toolUse",
			}),
			"started",
		);
		await t.type("start the job");
		t.press(KEY.enter);
		await t.until(shows("started"), "turn to finish");
		await t.until(() => !t!.host.session.isStreaming, "idle parent");

		await quit();
		await t.until(shows("Stop 1 bash job and quit?"), "the question");
		expect(t.shutdowns).toBe(0);
		t.press(KEY.esc);
		await t.until(shows("quit cancelled"), "the decline to be reported");
		expect(t.shutdowns).toBe(0);

		await quit();
		await t.until(shows("Stop 1 bash job and quit?"), "the question again");
		t.press(KEY.enter);
		await t.until(() => t!.shutdowns === 1, "shutdown");
	});

	it("asks one question over a running reply", async () => {
		t = await startUi();
		const reply = hang();
		t.script(reply);
		await t.type("start");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming, "streaming");
		await quit();
		await t.until(shows("Stop the running reply and quit?"), "the question");
		t.press(KEY.enter);
		await t.until(() => t!.shutdowns === 1, "shutdown");
		expect(await t.text()).not.toContain("Running work");
		reply.release();
	});

	it("quits at once with nothing running", async () => {
		t = await startUi();
		await quit();
		await t.until(() => t!.shutdowns === 1, "shutdown");
		expect(await t.text()).not.toContain("Running work");
	});
});
