import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { itemDetail } from "../../src/octocode/backlog/format.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { repo, reportOf, setup, useScriptedChild } from "./subagent-tool-harness.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

useScriptedChild();

describe("a child bound to a backlog item", () => {
	const READY = { goal: "Expected result", why: "Required work" };

	it("claims an unheld item for the call, but refuses one another live session holds, before any child is claimed", async () => {
		const s = setup();
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "theirs", state: "todo", createdBy: "user" });
		backlog.store.update("B2", { state: "ongoing" }, { id: "other-session" });
		await expect(s.run({ task: "report back", item: "B2" })).rejects.toThrow(
			/B2 is held by other-session, not by this session/,
		);
		await expect(s.run({ task: "report back", item: "B7" })).rejects.toThrow(/No backlog item B7/);
		expect(s.control.running()).toEqual([]);
		expect(backlog.store.get("B1")!.state).toBe("todo");
		const result = await s.run({ task: "report back", item: "B1" });
		expect(result.content[0].text as string).toContain("B1");
		expect(backlog.store.get("B1")).toMatchObject({ state: "ongoing", assignee: "session-test" });
	});

	it("leaves an unheld item unclaimed when the call is refused after the item check (unknown profile, unknown mcp server)", async () => {
		const s = setup();
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		await expect(s.run({ task: "report back", item: "B1", profile: "no-such-profile" })).rejects.toThrow();
		await expect(s.run({ task: "report back", item: "B1", mcp: ["no-such-server"] })).rejects.toThrow();
		expect(backlog.store.get("B1")).toMatchObject({ state: "todo" });
		expect(backlog.store.noteCount(backlog.store.get("B1")!)).toBe(0);
	});

	it("hands the item to the child in its environment and identity, and notes each report on it", async () => {
		const s = setup();
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const result = await s.run({ task: "report back", item: "b1" });
		const text = result.content[0].text as string;
		const facts = reportOf(text);
		expect(facts.item).toBe("B1");
		expect(facts.task).toContain("`B1`");
		// The parent's own line, after the fence, says the report was noted.
		expect(text).toMatch(/>>>\nNoted on B1\.$/);
		const notes = () => backlog.store.notes(backlog.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(notes().map((note) => note.text)).toEqual([`Report from ${facts.id}: no outcome word.`]);

		const started = await s.run({ task: "item report", item: "B1", background: true });
		const id = started.details.id as string;
		await vi.waitFor(() => expect(s.sent.length).toBe(1));
		expect(String(s.sent[0].message.content)).toMatch(/reported done[\s\S]*>>>\n[\s\S]*Noted on B1\./);
		// A child no longer finishes its coordinator's item (contract change): a done report notes the checks it names.
		expect(notes().at(-1)!.text).toBe(
			`Report from ${id}: done. Checks it names: yarn vitest run a.test.ts: 3 passed; yarn tsc: clean.`,
		);
	});

	it("records a run for the item whose outcome and agent agree with the note its report left (B38)", async () => {
		const s = setup();
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const foreground = reportOf((await s.run({ task: "report back", item: "B1" })).content[0].text as string);
		const started = await s.run({ task: "item report", item: "B1", background: true });
		const id = started.details.id as string;
		await vi.waitFor(() => expect(s.sent.length).toBe(1));
		const item = backlog.store.get("B1")!;
		const notes = backlog.store.notes(item, -1).filter((note) => note.kind === "note");
		const runs = backlog.store.runs(item);
		// Both runs are filed under the item, newest first, with the agent the note names.
		expect(runs.map((run) => run.agentId)).toEqual([id, foreground.id]);
		expect(notes.map((note) => note.text.split(":")[0])).toEqual([`Report from ${foreground.id}`, `Report from ${id}`]);
		expect(runs[1]).toMatchObject({ kind: "child", backlog: { seq: 1 }, startedBy: "agent", outcome: undefined });
		expect(notes[0].text).toContain("no outcome word");
		expect(runs[0].outcome).toBe("done");
		expect(notes[1].text).toContain(`${runs[0].outcome}.`);
		expect(runs.every((run) => run.endedAt !== undefined)).toBe(true);
		// `backlog get` shows them, and the team resolves the agent from the item.
		expect(itemDetail(item, [], 0, Date.now(), { runs })).toContain(`- ${id} `);
		expect(s.team.audit.resolve("B1")?.agentId).toBe(id);
		await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
	});

	it("links an isolated child's saved ref on its item as unmerged, and /agents merge notes the merge", async () => {
		const dir = repo();
		const s = setup(dir);
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const result = await s.run({ task: "edit a file", isolate: true, item: "B1" });
		const id = result.details.id as string;
		const ref = `refs/octocode/${id}`;
		expect(result.content[0].text).toContain(`Linked ${ref} on B1.`);
		const notes = () => backlog.store.notes(backlog.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(backlog.store.get("B1")!.links).toEqual([
			{ relation: "output", target: { resource: "files", repositoryKey: backlog.store.repo, path: ref } },
		]);
		expect(notes().at(-1)!.text).toBe(
			`The isolated change is saved on ${ref}, not merged yet. Merge it with \`agent\` type \`coordinate\`, action \`merge\`, id \`${id}\` (the user: \`/agents merge ${id}\`).`,
		);

		await s.commands.get("agents").handler(`merge ${id}`, s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toMatchObject({ type: "info" });
		expect(s.ctx.ui.notes.at(-1)!.message).toContain("Noted on B1.");
		expect(notes().at(-1)!.text).toMatch(new RegExp(`^The isolated change on ${ref} was merged into \\S+\\.$`));
	}, 30_000);
});

describe("a message to a finished subagent", () => {
	/** The `agent` task call and result a session records (what `resume` and a message-started resume read). */
	const recorded = (input: Record<string, unknown>, details: Record<string, unknown>): unknown[] => [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "agent", arguments: { type: "task", ...input } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "agent",
				details: { ...details, agentType: "task" },
			},
		},
	];
	const lingerReports = (s: ReturnType<typeof setup>) =>
		s.sent.map((entry) => String(entry.message.content)).filter((text) => text.includes("LINGER"));

	/** A parent session whose foreground child ran to its end (no linger window) and whose entries record that run as `input`. */
	async function finishedChild(input: Record<string, unknown> = {}) {
		const s = setup();
		const entries: unknown[] = [];
		Object.assign((s.ctx as { sessionManager: object }).sessionManager, { getEntries: () => entries });
		await s.fire("session_start", { type: "session_start" }, s.ctx);
		const first = await s.run({ task: "linger first" });
		expect(first.isError).toBeUndefined();
		await s.control.settle();
		entries.push(...recorded({ goal: "check things", task: "linger first", ...input }, structuredClone(first.details)));
		return { s, id: first.details.id as string, session: first.details.session as { id: string; file: string } };
	}

	it("resumes its saved conversation in the background with the stored message, when the parent sends", async () => {
		const { s, id, session } = await finishedChild();
		try {
			const result = await s.team.send(id, "linger again with the fix");
			expect(result).toMatchObject({
				sent: [id],
				resumed: expect.stringContaining(`Resumed ${id} with your message.`),
			});
			const messageId = (result as { id: number }).id;
			await s.control.settle();
			const report = lingerReports(s).at(-1)!;
			expect(report).toContain(`--session-id ${session.id}`);
			// Delivered as mail from its coordinator, naming the stored message a reply can answer.
			expect(report).toContain(`Message #${messageId} from your coordinator`);
			expect(report).toContain("linger again with the fix");
			expect(report).not.toContain("Follow-up from your coordinator:");
			const store = TeamStore.open(s.cwd, process.env.OCTOCODE_AGENT_DB);
			try {
				expect(store.refs.read(messageId)).toMatchObject({ text: "linger again with the fix" });
			} finally {
				store.close();
			}
			// A resume that cannot start (its transcript is gone) says why and leaves no stored message behind.
			fs.rmSync(session.file);
			await expect(s.team.send(id, "linger once more")).rejects.toThrow("is gone");
			const after = TeamStore.open(s.cwd, process.env.OCTOCODE_AGENT_DB);
			try {
				const rows = Array.from({ length: 20 }, (_, n) => after.refs.read(messageId + 1 + n));
				expect(rows.filter((row) => typeof row === "object" && row.text === "linger once more")).toEqual([]);
			} finally {
				after.close();
			}
		} finally {
			await s.control.stopAll();
			s.team.stop();
		}
	}, 30_000);

	it("keeps refusing an isolated child and a vendor runner's child", async () => {
		for (const input of [{ isolate: true }, { runner: "codex" }]) {
			const { s, id } = await finishedChild(input);
			try {
				const before = lingerReports(s).length;
				const refused = await s.team.send(id, "linger again");
				expect(refused).toEqual({ error: expect.stringContaining(`${id} has finished and takes no more messages`) });
				await s.control.settle();
				expect(lingerReports(s)).toHaveLength(before);
			} finally {
				await s.control.stopAll();
				s.team.stop();
			}
		}
	}, 30_000);
});
