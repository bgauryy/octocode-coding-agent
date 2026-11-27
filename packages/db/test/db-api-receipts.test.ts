import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiReceipts, openDatabase, purge, type AgentDb } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	const dir = tmp();
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
});
afterEach(() => agent.close());

const row = { fingerprint: "f", messageId: "x1", queued: "turn", phase: "preparing" } as const;

describe("api message receipts", () => {
	it("keeps a receipt per session and key, moves its phase and forgets it", () => {
		apiReceipts.save(agent.db, "s1", "k", row, 10);
		expect(apiReceipts.find(agent.db, "s1", "k")).toEqual({ ...row, updatedAt: 10 });
		expect(apiReceipts.find(agent.db, "s2", "k")).toBeUndefined();
		apiReceipts.setPhase(agent.db, "s1", "k", "accepted", 11);
		expect(apiReceipts.find(agent.db, "s1", "k")).toMatchObject({ phase: "accepted", updatedAt: 11 });
		apiReceipts.forget(agent.db, "s1", "k");
		expect(apiReceipts.find(agent.db, "s1", "k")).toBeUndefined();
	});

	it("drops week-old rows when a new one is written, and is emptied by purge.all", () => {
		apiReceipts.save(agent.db, "s1", "old", row, 0);
		apiReceipts.save(agent.db, "s1", "new", row, 8 * 24 * 3_600_000);
		expect(apiReceipts.find(agent.db, "s1", "old")).toBeUndefined();
		expect(purge.all(agent.db, agent.mirror.db).api_message_receipts).toBe(1);
	});
});
