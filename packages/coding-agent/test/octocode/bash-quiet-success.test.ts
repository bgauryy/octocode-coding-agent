import { expect, it, vi } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** Runs one background command through the real bash tool and returns the message its exit sent. */
async function exitMessage(params: Record<string, unknown>, stop = false) {
	const { api, tools, fire } = fakeHost();
	const sending = vi.spyOn(api.session, "sendMessage").mockResolvedValue(undefined);
	const jobs = new BashJobs(tmp());
	registerBashTool(api, undefined, jobs, () => ({}));
	const ctx = fakeCtx({ cwd: tmp() });
	try {
		await fire("session_start", { reason: "startup" }, ctx);
		const result = await tools.get("bash").execute("job", { background: true, ...params }, undefined, undefined, ctx);
		if (stop) await jobs.stopAll("user");
		await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1));
		const [message, options] = sending.mock.calls[0] as unknown as [{ content: string }, { triggerTurn?: boolean }];
		return { text: message.content, wakes: options.triggerTurn === true, log: result.structuredContent.log as string };
	} finally {
		await jobs.stopAll("session end");
	}
}

it("wake:false: a successful job sends a header-only note and starts no turn", async () => {
	const sent = await exitMessage({ command: "echo out-$((6*7))", wake: false });
	expect(sent.wakes).toBe(false);
	expect(sent.text).toContain("exit 0");
	expect(sent.text).toContain(sent.log.split("/").at(-1));
	expect(sent.text).not.toContain("out-42");
});

it("wake:false: a failed job still wakes with its output tail", async () => {
	const sent = await exitMessage({ command: "echo bad-$((6*7)); exit 3", wake: false });
	expect(sent.wakes).toBe(true);
	expect(sent.text).toContain("exit 3");
	expect(sent.text).toContain("bad-42");
});

it("wake:false: a job stopped by the user is not recorded as a quiet success", async () => {
	const sent = await exitMessage({ command: "sleep 30", wake: false }, true);
	expect(sent.text).toContain("stopped");
});

it("default: a successful job wakes with its output tail", async () => {
	const sent = await exitMessage({ command: "echo out-$((6*7))" });
	expect(sent.wakes).toBe(true);
	expect(sent.text).toContain("out-42");
});
