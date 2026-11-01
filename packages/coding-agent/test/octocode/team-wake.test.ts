import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { WAKE_INTERVAL_MS } from "../../src/octocode/team/wake-pace.ts";
import { liveSession } from "./team-live-session.ts";

/** A peer's `sendMessage` with `wake: true` in a real session: one turn, no reply owed, paced. */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of closers.splice(0)) await close();
});

const mailEntries = (live: Awaited<ReturnType<typeof liveSession>>) =>
	live.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");

async function idleSession() {
	const live = await liveSession({ tools: [] });
	closer(live);
	live.faux.setResponses(
		Array.from({ length: 4 }, () => (context: Parameters<typeof live.record>[0]) => {
			live.record(context);
			return fauxAssistantMessage("noted");
		}),
	);
	return live;
}
const closer = (live: Awaited<ReturnType<typeof liveSession>>) => closers.push(() => live.close());

describe("wake: true from a peer", () => {
	it("starts one turn of an idle session and owes no reply", async () => {
		const live = await idleSession();
		const sent = await live.peer.send(live.id, "MAIL: please look at the build", { wake: true });
		expect(sent).toMatchObject({ delivery: { [live.id]: "wake" } });
		const id = "id" in sent ? sent.id : -1;

		await vi.waitFor(() => expect(live.requests).toHaveLength(1), { timeout: 5_000 });
		await live.session.waitForIdle();
		expect(live.requests[0].mail).toHaveLength(1);
		const delivered = JSON.stringify(mailEntries(live));
		expect(delivered).toContain("FYI: no reply needed.");
		expect(delivered).not.toContain("replyTo");
		expect(mailEntries(live)).toHaveLength(1);

		// The recipient's reply to it is an FYI: it does not start the sender's turn.
		await live.team.send(live.peer.id, "MAIL: done", { replyTo: id });
		const store = TeamStore.open(live.cwd, live.db);
		try {
			expect(store.pending(live.peer.id!).map((message) => message.wake)).toEqual([false]);
			expect(store.recent().find((message) => message.id === id)?.state).not.toBe("awaiting reply");
		} finally {
			store.close();
		}
	}, 20_000);

	it("holds a second peer wake inside the interval and hands it, once, with the next allowed turn", async () => {
		const live = await idleSession();
		await live.peer.send(live.id, "MAIL: first", { wake: true });
		await vi.waitFor(() => expect(live.requests).toHaveLength(1), { timeout: 5_000 });
		await live.session.waitForIdle();

		await live.peer.send(live.id, "MAIL: second", { wake: true });
		// Two ticks pass: held, so no new turn and no second copy of the first message.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(live.requests).toHaveLength(1);
		expect(mailEntries(live)).toHaveLength(1);

		const real = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => real() + WAKE_INTERVAL_MS + 1_000);
		await vi.waitFor(() => expect(live.requests).toHaveLength(2), { timeout: 5_000 });
		await live.session.waitForIdle();
		expect(mailEntries(live)).toHaveLength(2);
		expect(live.requests[1].mail).toHaveLength(2);
	}, 30_000);

	it("is refused for to: all, and nothing is sent", async () => {
		const live = await idleSession();
		const sent = await live.peer.send("all", "MAIL: everyone", { wake: true });
		expect(sent).toMatchObject({ error: expect.stringContaining("Nothing was sent") });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(live.requests).toHaveLength(0);
		expect(mailEntries(live)).toHaveLength(0);
	}, 20_000);
});
