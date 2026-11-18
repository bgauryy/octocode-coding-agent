import { expect, it, vi } from "vitest";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

it("warns in the active session when a finished job report is rejected asynchronously", async () => {
	const { api, tools, fire } = fakeHost();
	let rejectDelivery!: (reason: Error) => void;
	const delivery = new Promise<void>((_resolve, reject) => {
		rejectDelivery = reject;
	});
	const sending = vi.spyOn(api.session, "sendMessage").mockReturnValue(delivery);
	const jobs = new BashJobs(tmp());
	registerBashTool(api, undefined, jobs, () => ({}));
	const ctx = fakeCtx({ cwd: tmp() });
	try {
		await fire("session_start", { reason: "startup" }, ctx);
		const result = await tools
			.get("bash")
			.execute("job", { command: "true", background: true }, undefined, undefined, ctx);
		await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1));
		rejectDelivery(new Error("session refused job report"));
		await vi.waitFor(() => expect(ctx.ui.notes).toHaveLength(1));
		expect(ctx.ui.notes[0]).toMatchObject({ type: "warning" });
		expect(ctx.ui.notes[0].message).toContain(result.structuredContent.job);
		expect(ctx.ui.notes[0].message).toContain(result.structuredContent.log);
	} finally {
		await jobs.stopAll("session end");
	}
});

it("does not show a rejected report in a later session", async () => {
	const { api, tools, fire } = fakeHost();
	let rejectDelivery!: (reason: Error) => void;
	const delivery = new Promise<void>((_resolve, reject) => {
		rejectDelivery = reject;
	});
	const sending = vi.spyOn(api.session, "sendMessage").mockReturnValue(delivery);
	const jobs = new BashJobs(tmp());
	registerBashTool(api, undefined, jobs, () => ({}));
	const previous = fakeCtx({ cwd: tmp() });
	const next = fakeCtx({ cwd: tmp() });
	try {
		await fire("session_start", { reason: "startup" }, previous);
		await tools.get("bash").execute("job", { command: "true", background: true }, undefined, undefined, previous);
		await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1));
		await fire("session_start", { reason: "switch" }, next);
		rejectDelivery(new Error("old report rejected"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(previous.ui.notes).toEqual([]);
		expect(next.ui.notes).toEqual([]);
	} finally {
		await jobs.stopAll("session end");
	}
});

it("does not notify a closing session after its report is rejected", async () => {
	const { api, tools, fire } = fakeHost();
	let rejectDelivery!: (reason: Error) => void;
	const delivery = new Promise<void>((_resolve, reject) => {
		rejectDelivery = reject;
	});
	const sending = vi.spyOn(api.session, "sendMessage").mockReturnValue(delivery);
	const jobs = new BashJobs(tmp());
	registerBashTool(api, undefined, jobs, () => ({}));
	const ctx = fakeCtx({ cwd: tmp() });
	try {
		await fire("session_start", { reason: "startup" }, ctx);
		await tools.get("bash").execute("job", { command: "true", background: true }, undefined, undefined, ctx);
		await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1));
		await fire("session_shutdown", {}, ctx);
		rejectDelivery(new Error("closing session refused report"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ctx.ui.notes).toEqual([]);
	} finally {
		await jobs.stopAll("session end");
	}
});
