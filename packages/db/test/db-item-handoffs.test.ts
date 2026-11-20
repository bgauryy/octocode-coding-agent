import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemHandoffs, openDatabase, purge, type AgentDb } from "../src/api.ts";
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

describe("itemHandoffs", () => {
	it("grants, lists and revokes the items handed to one agent", () => {
		itemHandoffs.grant(agent.db, "kid", 7, "boss", 2);
		itemHandoffs.grant(agent.db, "kid", 3, "boss", 1);
		itemHandoffs.grant(agent.db, "kid", 7, "boss", 2);
		itemHandoffs.grant(agent.db, "other", 3, "boss", 1);
		expect(itemHandoffs.itemsOf(agent.db, "kid")).toEqual([3, 7]);
		expect(itemHandoffs.holds(agent.db, "kid", 7)).toBe(true);
		expect(itemHandoffs.holds(agent.db, "nobody", 7)).toBe(false);
		itemHandoffs.revoke(agent.db, "kid", 7);
		expect(itemHandoffs.itemsOf(agent.db, "kid")).toEqual([3]);
		itemHandoffs.revoke(agent.db, "kid");
		expect(itemHandoffs.itemsOf(agent.db, "kid")).toEqual([]);
		expect(itemHandoffs.holds(agent.db, "other", 3)).toBe(true);
	});

	it("creates its table in a file made without it", () => {
		agent.db.exec("DROP TABLE item_handoffs");
		const again = openDatabase({
			file: agent.file,
			mirrorFile: path.join(path.dirname(agent.file), "transcripts.db"),
			archiveDir: path.join(path.dirname(agent.file), "archive"),
			privateParent: false,
		});
		try {
			itemHandoffs.grant(again.db, "kid", 1, "boss", 1);
			expect(itemHandoffs.holds(again.db, "kid", 1)).toBe(true);
		} finally {
			again.close();
		}
	});

	it("is emptied by purge.all", () => {
		itemHandoffs.grant(agent.db, "kid", 1, "boss", 1);
		expect(purge.all(agent.db, agent.mirror.db).item_handoffs).toBe(1);
		expect(itemHandoffs.holds(agent.db, "kid", 1)).toBe(false);
	});
});
