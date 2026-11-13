import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { refreshItemTitles } from "../../src/octocode/backlog/title-lookup.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { itemTitle, setItemTitles, TITLE_CAP, withItemTitles } from "../../src/octocode/render/item-titles.ts";

const known: Record<string, string> = { B92: "Clickable backlog IDs", B5: "Other work" };
const titleOf = (ref: string) => known[ref];

describe("withItemTitles", () => {
	it("puts the title after a known ID", () => {
		expect(withItemTitles("Close B92: goal verified", titleOf)).toBe(
			"Close B92 “Clickable backlog IDs”: goal verified",
		);
	});

	it("leaves an unknown ID unchanged", () => {
		expect(withItemTitles("Close B7: done", titleOf)).toBe("Close B7: done");
	});

	it("decorates several IDs in one line, each once", () => {
		expect(withItemTitles("B92 blocks B5, then B92 again", titleOf)).toBe(
			"B92 “Clickable backlog IDs” blocks B5 “Other work”, then B92 again",
		);
	});

	it("decorates once per line, not once per text", () => {
		expect(withItemTitles("B5\nB5", titleOf)).toBe("B5 “Other work”\nB5 “Other work”");
	});

	it("is idempotent on an already decorated ID", () => {
		const once = withItemTitles("B5 x", titleOf);
		expect(withItemTitles(once, titleOf)).toBe(once);
	});

	it("caps a long title with an ellipsis", () => {
		const long = "x".repeat(100);
		const out = withItemTitles("B1", () => long);
		const title = out.slice("B1 “".length, -1);
		expect(title).toHaveLength(TITLE_CAP);
		expect(title.endsWith("…")).toBe(true);
	});

	it("cuts the line to the width", () => {
		const out = truncateToWidth(withItemTitles("Close B92: goal verified", titleOf), 20);
		expect(visibleWidth(out)).toBeLessThanOrEqual(20);
		expect(out.startsWith("Close B92 “Click")).toBe(true);
	});

	it("styles the pieces without changing the text", () => {
		const out = withItemTitles("a B5 b", titleOf, {
			id: (s) => `<${s}>`,
			title: (s) => `[${s}]`,
			text: (s) => s.toUpperCase(),
		});
		expect(out).toBe("A <B5>[ “Other work”] B");
	});

	it("never changes its input", () => {
		const stored = "Close B92: goal verified";
		withItemTitles(stored, titleOf);
		expect(stored).toBe("Close B92: goal verified");
	});
});

describe("item title cache", () => {
	let tmp: string;
	let saved: string | undefined;
	let cwd: string;
	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-titles-")));
		saved = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
		cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		setItemTitles(new Map());
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setItemTitles(new Map());
		closeSharedAgentDb();
		if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
		else process.env.OCTOCODE_AGENT_DB = saved;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("resolves titles after a refresh and picks up a later change only on the next refresh", () => {
		const store = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
		const ready = { goal: "Expected result", why: "Required work", state: "todo" as const, createdBy: "user" };
		store.add({ ...ready, title: "First item" });
		expect(itemTitle("B1")).toBeUndefined();
		refreshItemTitles(store);
		expect(itemTitle("B1")).toBe("First item");
		store.add({ ...ready, title: "Second item" });
		expect(itemTitle("B2")).toBeUndefined();
		refreshItemTitles(store);
		expect(itemTitle("B2")).toBe("Second item");
		expect(itemTitle("B9")).toBeUndefined();
	});

	it("loads titles without full item enrichment, isolates workspaces, and replaces old titles", () => {
		const store = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
		const actor = { id: "user", kind: "human" as const };
		const ready = { goal: "Expected result", why: "Required work", createdBy: "user" };
		store.add({ ...ready, title: "Open item" }, actor);
		store.add({ ...ready, title: "Closed item" }, actor);
		store.update("B2", { close: { kind: "wont_do", text: "No longer needed" } }, actor);
		const otherCwd = path.join(tmp, "other");
		fs.mkdirSync(otherCwd);
		const other = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(otherCwd).id);
		other.add({ ...ready, title: "Different workspace" }, actor);
		const list = vi.spyOn(store, "list").mockImplementation(() => {
			throw new Error("Full item enrichment");
		});
		const db = sharedAgentDb().db;
		const prepare = vi.spyOn(db, "prepare");
		refreshItemTitles(store);
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(list).not.toHaveBeenCalled();
		expect(itemTitle("B1")).toBe("Open item");
		expect(itemTitle("B2")).toBe("Closed item");
		prepare.mockRestore();
		store.update("B1", { title: "Renamed item" }, actor);
		refreshItemTitles(store);
		expect(itemTitle("B1")).toBe("Renamed item");
		refreshItemTitles(other);
		expect(itemTitle("B1")).toBe("Different workspace");
		expect(itemTitle("B2")).toBeUndefined();
	});
});
