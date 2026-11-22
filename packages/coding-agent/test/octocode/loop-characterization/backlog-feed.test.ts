import { afterEach, describe, expect, it, vi } from "vitest";
import { count, sleep, type Rig } from "./rig.ts";
import { backlogRig, restoreBacklogEnv } from "./backlog-rig.ts";

/**
 * The real backlog feed into the wake gate (RFC agent-event-loop R0, §4): another agent's audited change to an item this
 * session holds reaches the model as a hidden `backlog-peer` message in a turn of its own, once per item; the session's
 * own writes and unrelated items say nothing. R9 replaces the producer; the visible effect must stay.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
	restoreBacklogEnv();
});

async function held() {
	const made = await backlogRig();
	rigs.push(made.rig);
	const { store, session } = made;
	store.add({ title: "Mine", goal: "g", why: "w", state: "todo", createdBy: "user", paths: ["src/shared.ts"] });
	store.add({ title: "Overlapping", goal: "g", why: "w", state: "todo", createdBy: "user", paths: ["src/shared.ts"] });
	store.add({ title: "Unrelated", goal: "g", why: "w", state: "todo", createdBy: "user", paths: ["docs/other.md"] });
	store.update("B1", { state: "ongoing" }, { id: session });
	return made;
}

describe("the backlog feed into the gate", () => {
	it("a peer claiming an item over the held item's paths wakes the idle session once, with the overlap fact", async () => {
		const { rig, store } = await held();
		rig.harness.setResponses([rig.reply("noticed the overlap")]);
		store.update("B2", { note: "looking" }, { id: "peer" });
		await sleep(600);
		expect(rig.requests).toHaveLength(0);
		store.update("B2", { state: "ongoing" }, { id: "peer" });
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 15_000 });
		await rig.harness.session.waitForIdle();
		expect(
			count(rig.requests[0], "B2 claimed by peer and names paths that B1, which you hold, also names: src/shared.ts."),
		).toBe(1);
		expect(rig.harness.session.messages.some((m) => (m as { customType?: string }).customType === "backlog-peer")).toBe(
			true,
		);
	}, 30_000);

	it("a change to an unrelated item, and the session's own write, wake nobody", async () => {
		const { rig, store, session } = await held();
		rig.harness.setResponses([rig.reply("should not run")]);
		store.update("B3", { state: "ongoing" }, { id: "peer" });
		store.update("B1", { note: "my own note" }, { id: session });
		await sleep(1500);
		expect(rig.requests).toHaveLength(0);
	}, 15_000);

	it("the same peer claiming the same item again is not a second wake", async () => {
		const { rig, store } = await held();
		rig.harness.setResponses([rig.reply("first"), rig.reply("second")]);
		store.update("B2", { state: "ongoing" }, { id: "peer" });
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 15_000 });
		await rig.harness.session.waitForIdle();
		store.update("B2", { state: "todo" }, { id: "peer" });
		store.update("B2", { state: "ongoing" }, { id: "peer" });
		await sleep(1500);
		expect(rig.requests).toHaveLength(1);
	}, 30_000);
});
