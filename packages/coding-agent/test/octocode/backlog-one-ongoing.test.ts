import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { type BacklogStore, TaskError } from "../../src/octocode/backlog/store.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";

let dir: string;
let db: AgentDb;
let store: BacklogStore;
let clock: number;
const agent = { id: "session-a", kind: "agent" as const };
const other = { id: "session-b", kind: "agent" as const };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-one-ongoing-"));
	db = openAgentDb(path.join(dir, "db"));
	clock = 1_000;
	store = fixtureBacklog(
		() => db,
		"repo",
		() => ++clock,
	);
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

const claimedItem = (title: string) => {
	const item = store.add({ title, why: "Users need this", goal: "Result can be checked", createdBy: "user" });
	return store.update(item.ref, { state: "ongoing" }, agent);
};

describe("one ongoing step per item and actor", () => {
	it("refuses a second ongoing step, names the first, and allows it once the first is done or dropped", () => {
		const item = claimedItem("Held");
		const [t1, t2, t3] = ["one", "two", "three"].map((goal) => store.tasks.add({ goal, item: item.ref }, agent));
		store.tasks.update(t1.ref, { state: "ongoing" }, agent);

		const refused = () => store.tasks.update(t2.ref, { state: "ongoing" }, agent);
		expect(refused).toThrow(TaskError);
		expect(refused).toThrow(new RegExp(`${t1.ref}.*done or dropped`));
		expect(store.tasks.get(t2.ref)?.state).toBe("todo");

		// Re-saving the ongoing step is not a second claim.
		expect(store.tasks.update(t1.ref, { state: "ongoing", reason: "still going" }, agent).state).toBe("ongoing");

		store.tasks.update(t1.ref, { state: "done", result: "ok" }, agent);
		store.tasks.update(t2.ref, { state: "ongoing" }, agent);
		store.tasks.update(t2.ref, { state: "dropped" }, agent);
		expect(store.tasks.update(t3.ref, { state: "ongoing" }, agent).state).toBe("ongoing");
	});

	it("refuses a step added already ongoing while another is ongoing", () => {
		const item = claimedItem("Held");
		store.tasks.add({ goal: "first", item: item.ref, state: "ongoing" }, agent);
		expect(() => store.tasks.add({ goal: "second", item: item.ref, state: "ongoing" }, agent)).toThrow(/T1/);
		expect(store.tasks.add({ goal: "later", item: item.ref }, agent).state).toBe("todo");
	});

	it("counts per item: another item's ongoing step does not block", () => {
		const a = claimedItem("A");
		const b = claimedItem("B");
		store.tasks.add({ goal: "in a", item: a.ref, state: "ongoing" }, agent);
		expect(store.tasks.add({ goal: "in b", item: b.ref, state: "ongoing" }, agent).state).toBe("ongoing");
	});

	it("applies to a session's scratch steps, per session", () => {
		const first = store.tasks.add({ goal: "scratch one", session: agent.id, state: "ongoing" }, agent);
		const second = store.tasks.add({ goal: "scratch two", session: agent.id }, agent);
		expect(() => store.tasks.update(second.ref, { state: "ongoing" }, agent)).toThrow(new RegExp(first.ref));
		expect(store.tasks.add({ goal: "elsewhere", session: other.id, state: "ongoing" }, other).state).toBe("ongoing");
		store.tasks.update(first.ref, { state: "done", result: "ok" }, agent);
		expect(store.tasks.update(second.ref, { state: "ongoing" }, agent).state).toBe("ongoing");
	});
});
