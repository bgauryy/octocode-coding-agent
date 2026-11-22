import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A background job reports to the session that started it, a child included, and to no other session. */

const until = async (check: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const session = (id: string, cwd: string, settings: Record<string, unknown> = {}) => {
	const { api, tools, sent } = fakeHost();
	const bashJobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), bashJobs, () => settings);
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => id;
	const run = (params: Record<string, unknown>) =>
		tools.get("bash").execute("t", { reason: "Run it.", ...params }, undefined, undefined, ctx);
	return { run, sent, bashJobs };
};

const mentions = (sent: { message: { content?: unknown } }[], text: string) =>
	sent.filter((entry) => String(entry.message.content).includes(text));

describe.runIf(process.platform !== "win32")("a background job reports to its starter only", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("a job a child started ends into the child's log alone, never its parent's or a peer's", async () => {
		const cwd = tmp();
		const parent = session("s-parent", cwd);
		const peer = session("s-peer", cwd);
		vi.stubEnv(SUBAGENT_ENV, "1");
		const child = session("s-child", cwd);
		await child.run({ command: "echo child-job-marker", background: true });
		await until(() => mentions(child.sent, "child-job-marker").length > 0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(parent.sent).toHaveLength(0);
		expect(peer.sent).toHaveLength(0);
	});

	it("a session that joined a job lists it as one whose end wakes it, until it ends", async () => {
		const cwd = tmp();
		const first = session("s-starter", cwd);
		const second = session("s-joiner", cwd);
		await first.run({ command: "sleep 60", background: true });
		const joined = await second.run({ command: "sleep 60", background: true });
		expect(joined.structuredContent).toMatchObject({ joined: true });
		expect([...second.bashJobs.joined.values()]).toEqual([
			expect.objectContaining({ id: "bash-1", command: "sleep 60", pid: expect.any(Number) }),
		]);
		first.bashJobs.stop("bash-1", "user");
		await until(() => mentions(second.sent, "bash-1").length > 0);
		expect(second.bashJobs.joined.size).toBe(0);
	});

	it("a call moved to the background reports to its starter alone", async () => {
		const cwd = tmp();
		const other = session("s-other", cwd);
		vi.stubEnv(SUBAGENT_ENV, "1");
		const child = session("s-child-moved", cwd, { backgroundAfterSeconds: 1 });
		const started = await child.run({ command: "echo start; sleep 2; echo moved-marker" });
		expect(child.bashJobs.jobs.size).toBe(1);
		expect(JSON.stringify(started.structuredContent)).toContain("bash-1");
		await until(() => mentions(child.sent, "moved-marker").length > 0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(other.sent).toHaveLength(0);
	});
});
