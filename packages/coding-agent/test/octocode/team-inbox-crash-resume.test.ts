import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Crash and resume must not inject team mail twice (a recipient that accepted a message into its transcript but
 * crashed before the model saw it, then resumed under its recorded name). Every rejoin path retires the old row
 * (unread mail becomes dead letters) before a fresh inbox could hand it again; these tests pin that.
 */

const row = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: id.replace(/-[0-9a-f]{6}$/, ""),
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
	...extra,
});

const repo = () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, ".git"));
	return dir;
};

const stores: TeamStore[] = [];
const open = (cwd: string, file: string) => {
	const store = TeamStore.open(cwd, file, {});
	stores.push(store);
	return store;
};

const teams: Array<{ team: Team; ctx: ReturnType<typeof fakeCtx> }> = [];
function agent(dbFile: string, cwd: string, resumeAs?: string) {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerCollab(fake.api, team);
	const ctx = fakeCtx({ cwd });
	team.start(ctx, resumeAs);
	teams.push({ team, ctx });
	return { ...fake, team, ctx };
}

/** The team mail an agent's fake host received, oldest first (notices are entries without an id). */
const mailOf = (who: ReturnType<typeof agent>) =>
	who.sent
		.filter((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE)
		.flatMap((entry) => entry.message.details?.messages ?? []);

afterEach(() => {
	for (const { team } of teams.splice(0)) team.stop();
	for (const store of stores.splice(0)) store.close();
});

describe("crash and resume", () => {
	it("never hands a crashed agent's unread mail to the process that resumes its name", async () => {
		const cwd = repo();
		const store = open(cwd, path.join(tmp(), "team.sqlite"));
		store.save(row("sender"));
		// The crashed agent ran in a real other process, alive while the mail was sent to it.
		const crashed = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
		const started = processStartTime(crashed.pid!);
		store.save(row("bold", { pid: crashed.pid!, ...(started ? { started } : {}) }));
		try {
			const sent = store.send("sender", ["bold"], "the build is broken on arm64", { replyRequired: false });
			expect(sent).toMatchObject({ id: expect.any(Number), departed: [] });
			expect(store.pending("bold")).toHaveLength(1);
			// The crash: no leave and no acknowledgement; the row and the waiting mail stay.
			crashed.kill("SIGKILL");
			await new Promise((resolve) => crashed.once("exit", resolve));
			expect(store.pending("bold")).toHaveLength(1);
			// The session resumes in this process and claims the name it recorded.
			const mine = processStartTime(process.pid);
			const resumed = row("bold", {
				pid: process.pid,
				...(mine ? { started: mine } : {}),
				joinedAt: Date.now(),
				updatedAt: Date.now(),
			});
			expect(store.join(resumed)).toBe(true);
			// The claim retired the crashed row first: the unread mail became a dead letter, never a second hand-off.
			expect(store.pending("bold")).toHaveLength(0);
			expect(store.deadLetters("sender")).toEqual([
				expect.objectContaining({ id: sent.id, recipients: ["bold"], text: "the build is broken on arm64" }),
			]);
		} finally {
			try {
				crashed.kill("SIGKILL");
			} catch {
				/* already exited */
			}
		}
	});

	it("dead-letters an accepted but unseen FYI when its session ends, and the rejoined name receives nothing", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const a = agent(db, cwd);
		const b = agent(db, cwd);
		a.team.join();
		b.team.join();
		const bName = b.team.id!;
		const sent = await a.team.send(bName, "the build is broken on arm64");
		if ("error" in sent) throw new Error(sent.error);
		expect(sent).toMatchObject({ sent: [bName] });
		// The idle recipient accepts the FYI into its transcript; no model context ever acknowledges it.
		await vi.waitFor(() => expect(mailOf(b)).toHaveLength(1));
		expect(mailOf(b)[0]).toMatchObject({ from: a.team.id, text: "the build is broken on arm64" });
		// The session ends without the model seeing it (a reload or exit): the unread mail becomes a dead letter.
		b.team.stop();
		// The same session resumes under its recorded name: a fresh inbox must not receive the dead mail again.
		const b2 = agent(db, cwd, bName);
		expect(b2.team.id).toBe(bName);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(mailOf(b2)).toHaveLength(0);
		// The sender is told once that its message went unread.
		await vi.waitFor(() =>
			expect(
				mailOf(a).some(
					(entry) =>
						entry.id === undefined && String(entry.text).includes(`Message #${sent.id} to ${bName} was not read`),
				),
			).toBe(true),
		);
	});
});
