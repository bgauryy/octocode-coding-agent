import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallEvent, ToolCallEventResult } from "../../src/core/extensions/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** One session of a team sharing `dbFile`, with the reservation gate as `index.ts` wires it. */
function member(dbFile: string, cwd: string) {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	const collab = registerCollab(fake.api, team, {
		shellWrites: async (command) => {
			await shellParserReady();
			return reservationTargets(command);
		},
	});
	return { fake, team, collab, ctx: fakeCtx({ cwd }) };
}

const approve = async (m: ReturnType<typeof member>, event: ToolCallEvent) =>
	(await m.fake.fire("tool_call", event, m.ctx)) as ToolCallEventResult | undefined;

const bash = (command: string): ToolCallEvent => ({
	type: "tool_call",
	toolCallId: "t1",
	toolName: "bash",
	input: { command },
});

describe("a bash call approved before a peer reserves its target", () => {
	const members: Array<ReturnType<typeof member>> = [];
	afterEach(async () => {
		for (const m of members.splice(0)) await m.fake.emit("session_shutdown", {}, m.ctx);
	});

	async function setup() {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const peer = member(db, cwd);
		const me = member(db, cwd);
		members.push(peer, me);
		await peer.fake.emit("session_start", {}, peer.ctx);
		await me.fake.emit("session_start", {}, me.ctx);
		peer.team.join();
		me.team.join();
		const permission = new Permission({ api: me.fake.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
		permission.start(me.ctx);
		registerToolGates(me.fake.api, {
			permission,
			provenance: { check: () => undefined },
			collab: me.collab,
			hooks: { preToolUse: async () => undefined },
			sourcePolicy: { refresh: async () => undefined },
			activity: { checking: () => undefined },
			localReads: new Map(),
		} as unknown as ToolGatesOptions);
		return { peer, me };
	}

	it("is refused when it executes, because the approval predates the reservation", async () => {
		const { peer, me } = await setup();
		const event = bash("echo hi > shared.txt");
		// Approved: nothing is reserved yet (a batch approves every call before it runs any, and a prompt may wait on a user).
		const approved = await approve(me, event);
		expect(approved?.block).toBeUndefined();

		peer.team.lock(["shared.txt"], "editing");

		const stale = await approved?.revalidate?.();
		expect(stale).toMatchObject({ block: true });
		expect(stale?.reason).toContain("reserved");
	});

	it("still runs when the peer reserved something else", async () => {
		const { peer, me } = await setup();
		const approved = await approve(me, bash("echo hi > mine.txt"));
		peer.team.lock(["other.txt"], "editing");
		expect(await approved?.revalidate?.()).toBeUndefined();
	});
});
