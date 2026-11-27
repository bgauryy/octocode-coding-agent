import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { connectGuard } from "../../src/octocode/compose-guard.ts";
import type { ReservationHost } from "../../src/octocode/team/session/reservations.ts";
import { declareEditing, editingNotice } from "../../src/octocode/team/session/editing-notice.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { LEASE_MS } from "../../src/octocode/team/store/limits.ts";
import { asSetup, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("a file change names another live session that edits the same file", () => {
	const teams: Team[] = [];
	afterEach(() => {
		for (const team of teams.splice(0)) team.stop();
	});

	function session(db: string, cwd: string, sessionId: string) {
		const team = new Team(
			asSetup({
				sendMessage: () => undefined,
				appendEntry: () => undefined,
				getThinkingLevel: () => "off",
				getSettings: () => ({}),
			}) as never,
			{ OCTOCODE_AGENT_DB: db },
		);
		teams.push(team);
		team.start({
			cwd,
			sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
			isIdle: () => true,
		} as never);
		const guard = new FileGuard();
		connectGuard(guard, team);
		let tool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> } | undefined;
		registerFileTool(
			asSetup({
				getSettings: () => ({}),
				registerTool: (t: typeof tool) => {
					tool = t;
					return tool;
				},
				on: () => undefined,
			}) as never,
			guard,
			fakePermission(),
		);
		const edit = async (from: string, to: string, name = "a.ts") => {
			const result = await tool!.execute(
				"c",
				{ queries: [{ reason: "r", type: "edit", path: name, edits: [{ oldText: from, newText: to }] }] },
				undefined,
				undefined,
				{ cwd, hasUI: false },
			);
			return result.content.map((part) => part.text ?? "").join("\n");
		};
		return { team, edit };
	}

	function checkout() {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.writeFileSync(path.join(cwd, "a.ts"), "one");
		fs.writeFileSync(path.join(cwd, "b.ts"), "x");
		return { cwd, db: path.join(tmp(), "team.sqlite") };
	}

	it("names the first session in the second one's result, and refuses nothing", async () => {
		const { cwd, db } = checkout();
		const first = session(db, cwd, "sess-1");
		const second = session(db, cwd, "sess-2");
		expect(await first.edit("one", "two")).not.toContain("also being edited");
		const text = await second.edit("two", "three");
		expect(text).toContain(first.team.id);
		expect(text).toContain("sess-1");
		expect(text).toContain("a.ts");
		expect(fs.readFileSync(path.join(cwd, "a.ts"), "utf8")).toBe("three");
	});

	it("says nothing when the only lease is the session's own, on another file, or lapsed", async () => {
		const { cwd, db } = checkout();
		const first = session(db, cwd, "sess-1");
		const second = session(db, cwd, "sess-2");
		await first.edit("one", "two");
		expect(await first.edit("two", "three")).not.toContain("also being edited");
		expect(await second.edit("x", "y", "b.ts")).not.toContain("also being edited");
		const realNow = Date.now;
		Date.now = () => realNow() + LEASE_MS * 2;
		try {
			expect(await second.edit("three", "four")).not.toContain("also being edited");
		} finally {
			Date.now = realNow;
		}
	});

	it("leaves no lease behind when the edit is refused", async () => {
		const { cwd, db } = checkout();
		const owner = session(db, cwd, "sess-1");
		const refused = session(db, cwd, "sess-2");
		const later = session(db, cwd, "sess-3");
		expect(owner.team.lock(["b.ts"], "work")).toMatchObject({ ok: true });
		await expect(refused.edit("x", "y", "b.ts")).rejects.toThrow("reserved by");
		owner.team.unlock();
		const text = await later.edit("x", "y", "b.ts");
		expect(text).not.toContain(refused.team.id);
		expect(text).not.toContain("also being edited");
	});

	it("says and records nothing for a session that never joined, whatever the database is", () => {
		const host = {
			me: () => undefined,
			existing: () => {
				throw new Error("unusable database");
			},
			store: () => {
				throw new Error("unusable database");
			},
		} as unknown as ReservationHost;
		expect(editingNotice(host, "/w/a.ts", "a.ts")).toBeUndefined();
		expect(declareEditing(host, "/w/a.ts")).toBeUndefined();
	});

	it("reports a database error on the record as a line instead of failing a landed edit", () => {
		const host = {
			me: () => ({ id: "me" }),
			store: () => {
				throw new Error("database is locked");
			},
		} as unknown as ReservationHost;
		expect(declareEditing(host, "/w/a.ts")).toContain("Could not record");
	});
});
