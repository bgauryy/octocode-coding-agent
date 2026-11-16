import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockFrame, bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";

describe("Bedrock binary stream integrity", () => {
	it("does not hang on an unknown event frame", async () => {
		const output = await stream(bedrockModel, bedrockContext, {
			apiKey: "test",
			env: {},
			fetch: async () => bedrockResponse([{ futureEvent: {} }, ...bedrockTextEvents]),
		}).result();
		expect(["stop", "error"]).toContain(output.stopReason);
		if (output.stopReason === "error") expect(output.errorMessage).toEqual(expect.any(String));
	}, 1000);
	it("reports a truncated frame as a typed stream error", async () => {
		const frame = bedrockFrame({ messageStart: { role: "assistant" } });
		const response = stream(bedrockModel, bedrockContext, {
			apiKey: "test",
			env: {},
			fetch: async () =>
				new Response(frame.slice(0, -3), {
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				}),
		});
		const events = [];
		for await (const event of response) events.push(event);
		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect((await response.result()).stopReason).toBe("error");
	}, 1000);
	it.each(["throttlingException", "validationException"])("reports %s exception text", async (name) => {
		const output = await stream(bedrockModel, bedrockContext, {
			apiKey: "test",
			env: {},
			fetch: async () =>
				bedrockResponse([{ messageStart: { role: "assistant" } }, { [name]: { message: "fixture failure" } }], {
					"retry-after": "3",
				}),
		}).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe(
			`${name === "throttlingException" ? "Throttling error" : "Validation error"}: fixture failure`,
		);
		if (name === "throttlingException") expect(output.retryAfterMs).toBe(3000);
	});
});
