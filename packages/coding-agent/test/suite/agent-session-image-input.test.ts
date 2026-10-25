import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const image = {
	type: "image" as const,
	mimeType: "image/png",
	data: readFileSync(new URL("../../../ai/test/data/red-circle.png", import.meta.url)).toString("base64"),
};
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup(input: ("text" | "image")[] = ["text"]) {
	const harness = await createHarness({
		models: [
			{ id: "selected", input },
			{ id: "vision", input: ["text", "image"] },
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("seen")]);
	return harness;
}

it("rejects fresh images before recording the prompt or consuming a response", async () => {
	const harness = await setup();
	await expect(harness.session.prompt("inspect", { images: [image] })).rejects.toThrow("accept images");
	expect(harness.session.messages).toEqual([]);
	expect(harness.getPendingResponseCount()).toBe(1);
	expect(harness.session.isIdle).toBe(true);
	await harness.session.setModel(harness.getModel("vision")!);
	await harness.session.prompt("inspect", { images: [image] });
	expect(harness.getPendingResponseCount()).toBe(0);
});

it.each(["steer", "followUp"] as const)(
	"rejects unsupported %s attachments without adding a queue entry",
	async (mode) => {
		const harness = await setup();
		await expect(harness.session[mode]("inspect", [image])).rejects.toThrow("accept images");
		expect(harness.session.getQueuedInputs()).toEqual([]);
	},
);

it("rechecks queued input against a later model selection", async () => {
	const harness = await setup(["text", "image"]);
	await harness.session.followUp("inspect", [image]);
	harness.session.agent.state.model = { ...harness.getModel(), input: ["text"] };
	await harness.session.prompt("continue");
	expect(harness.session.messages.at(-1)).toMatchObject({
		role: "assistant",
		stopReason: "error",
		errorMessage: expect.stringContaining("accept images"),
	});
});

it("rejects image commands before returning an accepted receipt and retains their assets", async () => {
	const harness = await setup();
	const application = getApplicationPort(harness.session);
	const asset = application.uploadAsset({ data: image.data, mimeType: image.mimeType });
	const command = {
		id: "image-command",
		action: "prompt" as const,
		sessionId: harness.session.sessionId,
		text: "inspect",
		attachments: [asset.id],
	};
	await expect(application.execute(command)).rejects.toThrow("accept images");
	expect(application.getSnapshot().receipts).toEqual([]);
	expect(application.readAsset(asset.id)).toBeDefined();
	await harness.session.setModel(harness.getModel("vision")!);
	expect(application.getSnapshot().model?.input).toEqual(["text", "image"]);
	await expect(application.execute(command)).resolves.toMatchObject({ status: "accepted" });
	await harness.session.waitForIdle();
	application.dispose();
});

it("rejects virtual routing to a physical model that cannot accept pending images", async () => {
	const harness = await setup();
	const runtime = harness.session.modelRuntime;
	runtime.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto",
		route: () => ({ model: harness.getModel(), thinkingLevel: "off" }),
	});
	const virtual = runtime.getModel("router", "auto")!;
	await expect(
		runtime.resolveModel(virtual, [{ role: "user", content: [image], timestamp: 1 }], {
			reason: "user",
			thinkingLevel: "off",
		}),
	).rejects.toThrow("accept images");
});
