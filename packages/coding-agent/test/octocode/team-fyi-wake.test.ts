import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { WAKE_INTERVAL_MS } from "../../src/octocode/team/wake-pace.ts";
import { liveSession, type LiveOptions } from "./team-live-session.ts";

/**
 * Mail an agent sends to a named teammate starts an idle recipient's turn, so evidence it must act on is not left
 * on screen with nothing running. Replies wake only an asker that waits on them, so an acknowledgement never starts a
 * turn; broadcasts and `wake: false` wait for the next turn; peer-started turns stay paced.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of closers.splice(0)) await close();
});

const mailEntries = (live: Awaited<ReturnType<typeof liveSession>>) =>
	live.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");

async function idleSession(options: Partial<LiveOptions> = {}) {
	const live = await liveSession({ tools: [], ...options });
	closers.push(() => live.close());
	live.faux.setResponses(
		Array.from({ length: 4 }, () => (context: Parameters<typeof live.record>[0]) => {
			live.record(context);
			return fauxAssistantMessage("noted");
		}),
	);
	return live;
}

function pendingWakes(live: Awaited<ReturnType<typeof liveSession>>, id: string): boolean[] {
	const store = TeamStore.open(live.cwd, live.db);
	try {
		return store.pending(id).map((message) => message.wake === true);
	} finally {
		store.close();
	}
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 2_500));

describe("an FYI to a named agent", () => {
	it("starts one turn of an idle recipient, and the reply to it does not wake the sender", async () => {
		const live = await idleSession();
		const sent = await live.peer.send(live.id, "MAIL: check fails in your file");
		expect(sent).toMatchObject({ delivery: { [live.id]: "wake" } });
		const id = "id" in sent ? sent.id : -1;

		await vi.waitFor(() => expect(live.requests).toHaveLength(1), { timeout: 5_000 });
		await live.session.waitForIdle();
		expect(live.requests[0].mail).toHaveLength(1);

		await live.team.send(live.peer.id, "MAIL: fixed", { replyTo: id });
		expect(pendingWakes(live, live.peer.id!)).toEqual([false]);
	}, 20_000);

	it("wakes an idle coordinator when its child sends to parent", async () => {
		const live = await idleSession({
			peerEnv: (selfId) => ({ OCTOCODE_AGENT_ID: "child-1", OCTOCODE_PARENT_ID: selfId }),
		});
		const sent = await live.peer.send("parent", "MAIL: blocked on a lock");
		expect(sent).toMatchObject({ delivery: { [live.id]: "wake" } });
		await vi.waitFor(() => expect(live.requests).toHaveLength(1), { timeout: 5_000 });
	}, 20_000);

	it("waits for the next turn with wake: false", async () => {
		const live = await idleSession();
		const sent = await live.peer.send(live.id, "MAIL: for later", { wake: false });
		expect(sent).toMatchObject({ delivery: { [live.id]: "queued-quiet" } });
		await quiet();
		expect(live.requests).toHaveLength(0);
	}, 20_000);

	it("does not wake anyone when broadcast to all", async () => {
		const live = await idleSession({
			peerEnv: (selfId) => ({ OCTOCODE_AGENT_ID: "child-1", OCTOCODE_PARENT_ID: selfId }),
		});
		const sent = await live.peer.send("all", "MAIL: everyone");
		expect(sent).toMatchObject({ delivery: { [live.id]: "queued-quiet" } });
		await quiet();
		expect(live.requests).toHaveLength(0);
	}, 20_000);

	it("keeps a reply that answers nothing asked from waking its recipient", async () => {
		const live = await idleSession();
		const note = await live.team.send(live.peer.id, "MAIL: heads-up");
		const id = "id" in note ? note.id : -1;
		await live.peer.send(live.id, "MAIL: thanks", { replyTo: id });
		await quiet();
		expect(live.requests).toHaveLength(0);
	}, 20_000);

	it("holds a second peer FYI inside the pacing interval and hands both with the next allowed turn", async () => {
		const live = await idleSession();
		await live.peer.send(live.id, "MAIL: first");
		await vi.waitFor(() => expect(live.requests).toHaveLength(1), { timeout: 5_000 });
		await live.session.waitForIdle();

		await live.peer.send(live.id, "MAIL: second");
		await live.peer.send(live.id, "MAIL: third");
		await quiet();
		expect(live.requests).toHaveLength(1);

		const real = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => real() + WAKE_INTERVAL_MS + 1_000);
		await vi.waitFor(() => expect(live.requests).toHaveLength(2), { timeout: 5_000 });
		await live.session.waitForIdle();
		// The held FYIs arrive together, as one batch in one turn.
		expect(mailEntries(live)).toHaveLength(2);
		const batch = JSON.stringify(mailEntries(live)[1]);
		expect(batch).toContain("MAIL: second");
		expect(batch).toContain("MAIL: third");
	}, 30_000);
});
