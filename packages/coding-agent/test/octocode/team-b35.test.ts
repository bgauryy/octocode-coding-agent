import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import type { ReferenceHost } from "../../src/octocode/team/session/references.ts";
import { sendMessage } from "../../src/octocode/team/session/send.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { openWorkspaceDb } from "../../src/storage/workspace-database.ts";
import { tmp } from "./helpers.ts";
import type { AgentDb } from "../../../db/src/api.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const member = (id: string, parentId?: string, over: Partial<Member> = {}): Member => ({
	id,
	role: id.split("-")[0],
	...(parentId ? { parentId } : {}),
	pid: process.pid,
	status: "idle",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...over,
});

const cwd = tmp();
const open = (file: string) => TeamStore.open(cwd, file);

/** Runs `use` on the connection holding this checkout's workspace rows in the machine file `file` (the file itself while workspace files are off). */
function withWorkspaceRows<T>(file: string, use: (db: AgentDb["db"]) => T): T {
	const machine = openAgentDb(file);
	const rows = openWorkspaceDb(machine, cwd).agent;
	try {
		return use(rows.db);
	} finally {
		if (rows !== machine) rows.close();
		machine.close();
	}
}

function child(store: TeamStore, me: string): ReferenceHost {
	const self = store.list().find((each) => each.id === me);
	return {
		me: () => self,
		ctx: () => undefined,
		db: () => store,
		store: () => store,
		parentId: () => self?.parentId,
		finished: new Map(),
		reporting: () => false,
		resumer: () => undefined,
		messageHook: () => undefined,
		signed: () => undefined,
		signedByParent: () => undefined,
		mail: { createdForUser: () => undefined },
		started: () => false,
	};
}

describe("B35 team mail and liveness", () => {
	it("tells a subagent the truth about an Octocode process name: no route, send to the parent, nothing queued", async () => {
		const store = open(path.join(tmp(), "team.sqlite"));
		try {
			for (const each of [member("p-1"), member("a-1", "p-1")]) store.save(each);
			const result = await sendMessage(child(store, "a-1"), "octocode-agent-rpc-df792784", "ping");
			expect(result).toMatchObject({ error: expect.stringContaining("subagents have no route to other processes") });
			expect((result as { error: string }).error).toContain('Send to "parent" (your coordinator p-1)');
			expect(store.refs.relays("p-1")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("dead-letters unread mail to a recipient with no agent row, even when completed, and tells the sender", () => {
		const file = path.join(tmp(), "team.sqlite");
		const store = open(file);
		let id: number;
		try {
			for (const each of [member("p-1"), member("a-1", "p-1")]) store.save(each);
			id = store.send("p-1", ["a-1"], "fyi", { replyRequired: false }).id!;
		} finally {
			store.close();
		}
		// The recipient's row went some way other than retiring it, and the delivery was marked completed.
		withWorkspaceRows(file, (raw) => {
			raw.prepare("DELETE FROM agents WHERE id = 'a-1'").run();
			raw.prepare("UPDATE deliveries SET completed_at = 5 WHERE message = ?").run(id);
			raw.prepare("UPDATE messages SET created_at = created_at - 120000 WHERE id = ?").run(id);
		});
		const again = open(file);
		try {
			expect(again.deadLetters("p-1")).toEqual([{ id, recipients: ["a-1"], text: "fyi" }]);
		} finally {
			again.close();
		}
	});

	it("lists a member with a live process and a frozen heartbeat as stalled, and does not reap it", () => {
		const file = path.join(tmp(), "team.sqlite");
		const store = open(file);
		try {
			const now = Date.now();
			store.save(member("main-1"));
			store.save(member("bouncy-jelly", "main-1", { status: "working", updatedAt: now - 26 * 3_600_000 }));
			expect(store.list().map((each) => each.id)).toEqual(["main-1"]);
			const stalled = store.list(now, true);
			expect(stalled.map((each) => each.id)).toEqual(["bouncy-jelly"]);
			const text = describeMembers(store.list(now), "main-1", now, undefined, undefined, undefined, stalled);
			expect(text).toMatch(/bouncy-jelly · bouncy · stalled/);
			expect(text).toContain("has not been seen for");
			expect(text).toContain("it is not stopped");
			expect(text).not.toMatch(/bouncy-jelly · bouncy · working/);
			expect(store.list(now, true)).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("records the working directory and session folder of a child's session row when it joins", () => {
		const file = path.join(tmp(), "team.sqlite");
		const store = open(file);
		try {
			store.lifecycle = {
				activationId: "act-1",
				sessionId: "child-session",
				cwd: "/work/repo",
				dir: "/home/sessions/x",
			};
			store.join(member("a-1", "p-1"));
			// Session rows live in the machine file, with workspace files on or off.
			const machine = openAgentDb(file);
			const row = machine.db.prepare("SELECT cwd, dir, file FROM sessions WHERE id = 'child-session'").get();
			machine.close();
			expect(row).toMatchObject({ cwd: "/work/repo", dir: "/home/sessions/x", file: null });
		} finally {
			store.close();
		}
	});
});
