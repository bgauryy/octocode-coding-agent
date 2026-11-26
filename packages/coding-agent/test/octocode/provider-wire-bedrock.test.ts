import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { modelEntry, providerFor, wireBox } from "./provider-wire-box.ts";
import { REPLY_TEXT, sentText, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * Bedrock Converse stream through a custom provider on a loopback endpoint: a bearer key from models.json, and the
 * binary event-stream reply parsed. The SigV4 path needs the official `amazon-bedrock` provider, whose host models.json
 * cannot change, so it is not reachable without a host the guard refuses.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

describe("bedrock-converse-stream", () => {
	it("sends the prompt with the bearer key and parses the event-stream reply", async () => {
		wire = await startWire("bedrock-converse-stream");
		const box = wireBox();
		Object.assign(box.env, {
			AWS_REGION: "us-east-1",
			// No instance-metadata lookup: that address is not loopback and the guard would refuse it.
			AWS_EC2_METADATA_DISABLED: "true",
		});
		box.writeModels({
			gw: providerFor("bedrock-converse-stream", wire, {
				apiKey: "wire-bearer",
				models: [modelEntry("wire.model-v1")],
			}),
		});
		const result = await box.prompt("gw/wire.model-v1", "say hi to bedrock");
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(REPLY_TEXT);
		expect(wire.seen).toHaveLength(1);
		const [request] = wire.seen;
		expect(request.path).toMatch(/^\/model\/wire\.model-v1\/converse-stream/);
		expect(request.headers.authorization).toBe("Bearer wire-bearer");
		expect(sentText({ ...request, body: { messages: request.body.messages } })).toContain("say hi to bedrock");
		expect(box.violations()).toEqual([]);
	});
});
