import type { ApplicationFrame, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { ApplicationProjection, ApplicationStream } from "../src/index.ts";

const snapshot: ApplicationSnapshot = {
	sessionId: "session-a",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt", "abort"],
};
const frame = (
	sequence: number,
	body: Pick<ApplicationFrame, "type"> & Record<string, unknown>,
	epoch = "epoch-a",
): ApplicationFrame =>
	({
		protocolVersion: 1,
		cursor: { sessionId: "session-a", epoch, sequence },
		at: sequence,
		...body,
	}) as ApplicationFrame;

it("keeps live tool calls between the surrounding messages through progress and completion", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: {
				...snapshot,
				messages: [{ id: "before", role: "assistant", text: "Before", complete: true, order: 0 }],
			},
		}),
	);
	stream.accept(
		frame(1, {
			type: "event",
			event: { type: "tool.started", toolCallId: "t", toolName: "bash", hint: "npm test" },
		}),
	);
	stream.accept(
		frame(2, {
			type: "event",
			event: {
				type: "message.completed",
				message: { id: "after", role: "assistant", text: "After", complete: true, order: 2 },
			},
		}),
	);
	for (const [sequence, event] of [
		[3, { type: "tool.progress", toolCallId: "t", toolName: "bash", text: "running" }],
		[4, { type: "tool.completed", toolCallId: "t", toolName: "bash", text: "done" }],
	] as const) {
		stream.accept(frame(sequence, { type: "event", event }));
		expect(stream.snapshot?.tools?.[0]).toMatchObject({ order: 1, toolCallId: "t" });
	}
	expect(new ApplicationProjection().update(stream.snapshot, 5).map((item) => item.text.split("\n")[0])).toEqual([
		"Before",
		"bash",
		"After",
	]);
});
