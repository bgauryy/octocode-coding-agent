import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { liveSession } from "./team-live-session.ts";

// Team mail is handed to Octocode by a one-second tick and, at the end of a turn that ran tools, by the `turn_end`
// listener (`team/tools.ts`), just before the loop reads queued steering for the next request.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

const mailEntries = (live: Awaited<ReturnType<typeof liveSession>>) =>
	live.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");

describe("mail that arrives while a turn's tools run", () => {
	it("is in the very next model request, once", async () => {
		// The tool sends the peer's message and returns at once: no tick can fall between the send and the next request.
		const live: Awaited<ReturnType<typeof liveSession>> = await liveSession({
			tools: [
				{
					name: "send",
					run: async () => {
						await live.peer.send(live.id, "MAIL: change of plan", { replyRequired: false });
						return "sent";
					},
				},
				// Long enough for ticks to run after the handoff: they must not hand the same message over again.
				{ name: "wait", run: () => new Promise((resolve) => setTimeout(() => resolve("waited"), 2_200)) },
			],
		});
		closers.push(() => live.close());
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("send", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("finished");
			},
		]);
		await live.session.prompt("work");
		await live.session.waitForIdle();

		expect(live.requests.map((request) => request.mail.length)).toEqual([0, 1, 1]);
		expect(mailEntries(live)).toHaveLength(1);
	}, 20_000);
});

describe("mail that arrives during a turn without tools", () => {
	it("does not add a model request", async () => {
		const live = await liveSession({ tools: [] });
		closers.push(() => live.close());
		live.faux.setResponses([
			async (context) => {
				live.record(context);
				await live.peer.send(live.id, "MAIL: just so you know", { replyRequired: false });
				return fauxAssistantMessage("done");
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("an extra call");
			},
		]);
		await live.session.prompt("work");
		await live.session.waitForIdle();
		// The tick then puts the FYI in the transcript without starting a turn.
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		await live.session.waitForIdle();

		expect(live.requests).toHaveLength(1);
		expect(mailEntries(live)).toHaveLength(1);
	}, 20_000);
});
