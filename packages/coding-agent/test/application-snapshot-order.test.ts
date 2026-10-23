import { afterEach, expect, it } from "vitest";
import { getApplicationPort } from "../src/core/application/index.ts";
import { createHarness, type Harness } from "./test-harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

it("orders a snapshot's messages and tools the way they happened", async () => {
	harness = await createHarness({
		responses: [
			{ toolCalls: [{ id: "write", name: "write", args: { path: "notes.txt", content: "alpha\n" } }] },
			"Wrote the notes.",
		],
	});
	await harness.session.prompt("Write notes");
	const connection = getApplicationPort(harness.session).connect();
	const frames: Array<{
		type: string;
		snapshot?: {
			messages: Array<{ text: string; order?: number }>;
			tools?: Array<{ toolName: string; order?: number }>;
		};
	}> = [];
	const reading = (async () => {
		for await (const frame of connection) frames.push(frame);
	})();
	await new Promise((resolve) => setTimeout(resolve, 20));
	connection.close();
	await reading;

	const snapshot = frames.find((frame) => frame.type === "snapshot")?.snapshot;
	const tool = snapshot?.tools?.find((entry) => entry.toolName === "write");
	const answer = snapshot?.messages.find((message) => message.text.includes("Wrote the notes."));
	expect(tool?.order).toBeTypeOf("number");
	expect(answer?.order).toBeTypeOf("number");
	expect(tool!.order!).toBeLessThan(answer!.order!);
});
