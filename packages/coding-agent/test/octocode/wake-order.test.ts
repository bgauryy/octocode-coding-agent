import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { MAX_EVENT_WINDOW_SECONDS } from "../../src/core/settings-schema/runtime.ts";
import octocode from "../../src/octocode/index.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { IDLE_ITEM_TYPE } from "../../src/octocode/monitor/attention/idle-items.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
	process.env.OCTOCODE_AGENT_DB = path.join(tmp(), "octocode.db");
	delete process.env.OCTOCODE_SUBAGENT;
	vi.spyOn(os, "homedir").mockReturnValue(tmp());
});
afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	process.env = saved;
});

/**
 * The composed extension, a session that holds one ongoing item nothing works on, and a background job that keeps the
 * session waiting: the state in which a settling run names the idle item to its coordinator.
 */
async function settlingWithAnIdleItem() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	// The longest window there is, and no time passes in the test: only what is sent during the settle is seen.
	const fake = fakeHost({ runtime: { eventWindowSeconds: MAX_EVENT_WINDOW_SECONDS } });
	Object.assign(fake.api.session, { getName: () => undefined });
	await octocode(fake.api);
	const ctx = fakeCtx({ cwd });
	await fake.emit("session_start", { reason: "startup" }, ctx);
	const backlog = openBacklog(ctx, { isSubagent: false });
	const item = backlog.store.add({ goal: "g", why: "w", title: "held", state: "todo", createdBy: "user" });
	backlog.store.update(item.ref, { state: "ongoing" }, backlog.actor);
	await fake.emit("agent_start", {}, ctx);
	await fake.tools
		.get("bash")
		.execute("call-1", { reason: "Keep waiting.", command: "sleep 30", background: true }, undefined, undefined, ctx);
	const nudges = () => fake.sent.filter((entry) => entry.message.customType === IDLE_ITEM_TYPE);
	return { fake, ctx, ref: item.ref, nudges };
}

describe("agent_settled in the composed extension", () => {
	it("sends the idle-item nudge while the run settles, so it continues the run instead of waiting out the window", async () => {
		const s = await settlingWithAnIdleItem();
		try {
			expect(s.nudges()).toHaveLength(0);
			await s.fake.emit("agent_settled", { aborted: false }, s.ctx);
			// The session's loop still counted the run as in progress when the nudge arrived: it went out with the settle,
			// asking for a turn. Had the loop settled first, the nudge would sit in the idle window and nothing would be sent.
			expect(s.nudges()).toHaveLength(1);
			expect(s.nudges()[0].message.content).toContain(s.ref);
			expect(s.nudges()[0].options.triggerTurn).toBe(true);
		} finally {
			await s.fake.emit("session_shutdown", { reason: "quit" }, s.ctx);
		}
		// Once: the session's end has nothing of it left to hand over.
		expect(s.nudges()).toHaveLength(1);
	});
});
