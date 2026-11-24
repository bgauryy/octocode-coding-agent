import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPrompt } from "../../../src/core/prompt-template.ts";
import { BACKLOG_PEER_TYPE } from "../../../src/octocode/backlog/peer-notify.ts";
import { branchLines, count, quiet, type Rig } from "./rig.ts";
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

const peerMessages = (rig: Rig) =>
	rig.harness.session.messages.filter((m) => m.role === "custom" && m.customType === BACKLOG_PEER_TYPE);

describe("the backlog feed into the gate", () => {
	it("a peer claiming an item over the held item's paths wakes the idle session once, with the overlap fact", async () => {
		const { rig, store, fed } = await held();
		rig.harness.setResponses([rig.reply("noticed the overlap")]);
		store.update("B2", { note: "looking" }, { id: "peer" });
		// A note claims nothing: the feed read it and the session stays as it was.
		await fed({ ref: "B2", kind: "note", by: "peer" });
		await quiet(rig);
		expect(rig.requests).toHaveLength(0);
		expect(peerMessages(rig)).toHaveLength(0);
		store.update("B2", { state: "ongoing" }, { id: "peer" });
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 15_000 });
		await rig.harness.session.waitForIdle();
		// The overlap fact of this claim, whatever its wording: the item, the peer, the held item and the shared path.
		const fact = renderPrompt("notices/peer/overlap.md", {
			ref: "B2",
			kind: "claimed",
			by: "peer",
			other: "B1",
			paths: "src/shared.ts",
		}).trim();
		for (const part of ["B2", "peer", "B1", "src/shared.ts"]) expect(fact).toContain(part);
		expect(count(rig.requests[0], fact)).toBe(1);
		expect(peerMessages(rig)).toMatchObject([{ display: false }]);
	}, 30_000);

	it("a change to an unrelated item, and the session's own write, wake nobody", async () => {
		const { rig, store, session, fed } = await held();
		rig.harness.setResponses([rig.reply("should not run")]);
		store.update("B3", { state: "ongoing" }, { id: "peer" });
		store.update("B1", { note: "my own note" }, { id: session });
		await fed({ ref: "B3", kind: "claimed", by: "peer" });
		await fed({ ref: "B1", kind: "note", by: session });
		await quiet(rig);
		expect(rig.requests).toHaveLength(0);
		expect(peerMessages(rig)).toHaveLength(0);
	}, 15_000);

	it("the same peer claiming the same item again is not a second wake", async () => {
		const { rig, store, fed } = await held();
		rig.harness.setResponses([rig.reply("first"), rig.reply("second")]);
		store.update("B2", { state: "ongoing" }, { id: "peer" });
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 15_000 });
		await rig.harness.session.waitForIdle();
		store.update("B2", { state: "todo" }, { id: "peer" });
		store.update("B2", { state: "ongoing" }, { id: "peer" });
		await fed({ ref: "B2", kind: "claimed", by: "peer" }, 2);
		await quiet(rig);
		expect(rig.requests).toHaveLength(1);
		expect(peerMessages(rig)).toHaveLength(1);
		expect(count(branchLines(rig.harness), "src/shared.ts")).toBe(1);
	}, 30_000);
});
