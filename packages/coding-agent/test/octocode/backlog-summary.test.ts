import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backlogSummary } from "../../src/octocode/backlog/tool-text.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";

// Each backlog change shows as one row naming the item, its new state and its title, so a parent reports progress
// without restating the board.
describe("backlog update rows", () => {
	let dir: string;
	let db: ReturnType<typeof openAgentDb>;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-summary-"));
		db = openAgentDb(path.join(dir, "db"));
	});
	afterEach(() => {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("names the item, its new state and its title for each change", () => {
		const store = fixtureBacklog(() => db, "repo");
		const actor = { id: "parent" };
		const added = store.add({
			title: "Fix the roster",
			goal: "A test passes.",
			why: "Users see it.",
			createdBy: "parent",
		});
		expect(backlogSummary("add", { item: added }, "")).toBe(`Added ${added.ref} · backlog · Fix the roster`);

		const claimed = store.update(added.ref, { state: "ongoing" }, actor);
		expect(backlogSummary("claim", { item: claimed }, "")).toBe(`${added.ref} → ongoing · Fix the roster`);

		const closed = store.update(added.ref, { close: { kind: "obsolete", text: "Gone." } }, actor);
		expect(backlogSummary("close", { item: closed }, "")).toBe(`${added.ref} → closed · Fix the roster`);
	});

	it("counts a list instead of printing it", () => {
		expect(backlogSummary("list", { shown: 15, total: 40 }, "")).toBe("15 of 40 items");
		expect(backlogSummary("list", { shown: 3, total: 3 }, "")).toBe("3 items");
		expect(backlogSummary("list", { shown: 0, total: 0 }, "")).toBe("No items");
	});

	it("falls back to the first line of the tool's text when no item came back", () => {
		expect(backlogSummary("get", {}, "Nothing matched\nmore")).toBe("Nothing matched");
	});
});
